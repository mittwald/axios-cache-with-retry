import axios, {
  type AxiosAdapter,
  type AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { resolveRequestKey } from "./key.js";
import {
  cloneResponse,
  responseFromCache,
  snapshotResponse,
} from "./response.js";
import {
  DEFAULT_RETRY_STATUS,
  retryDelay,
  shouldRetry,
  sleep,
} from "./retry.js";
import { createMemoryStorage, deletePrefix } from "./storage.js";
import type {
  AxiosRetryCacheInstance,
  CacheEntry,
  CacheOptions,
  RetryCacheOptions,
  RetryCacheRequestOptions,
  RetryCacheStorage,
  RetryOptions,
} from "./types.js";

const DEFAULT_CACHE: CacheOptions = {
  enabled: true,
  ttl: 60_000,
  methods: ["get", "head"],
  staleIfError: false,
};

const DEFAULT_RETRY: RetryOptions = {
  enabled: true,
  retries: 2,
  methods: ["get", "head", "options"],
  retryOnStatus: DEFAULT_RETRY_STATUS,
  retryOnNetworkError: true,
  respectRetryAfter: true,
};

const installedAdapters = new WeakMap<AxiosInstance, AxiosAdapter>();

export function setupAxiosRetryCache(
  instance: AxiosInstance,
  options: RetryCacheOptions = {},
): AxiosRetryCacheInstance {
  const storage = options.storage ?? createMemoryStorage();
  const originalAdapter =
    installedAdapters.get(instance) ??
    axios.getAdapter(instance.defaults.adapter);
  const inflight = new Map<string, Promise<AxiosResponse>>();

  installedAdapters.set(instance, originalAdapter);

  instance.defaults.adapter = async (config) => {
    const requestOptions = config.retryCache;

    if (requestOptions === false) {
      return originalAdapter(config);
    }

    const effective = resolveEffectiveOptions(options, requestOptions);
    const method = (config.method ?? "get").toLowerCase();
    const cacheEnabled = Boolean(
      effective.cache && methodAllowed(method, effective.cache.methods),
    );
    const retryEnabled = Boolean(effective.retry);
    const dedupeEnabled = effective.dedupe !== false;
    const requestKey = await resolveRequestKey(options.requestKey, config);
    const cacheKey = requestKey;
    const dedupeKey = requestKey;

    if (!cacheEnabled && !retryEnabled) {
      return originalAdapter(config);
    }

    if (cacheEnabled && cacheKey) {
      const cached = await storage.get(cacheKey);

      if (cached && isFresh(cached)) {
        return responseFromCache(cached, config);
      }
    }

    const operation = () =>
      runOperation({
        adapter: originalAdapter,
        config,
        cacheKey,
        cacheEnabled,
        retry: effective.retry,
        cache: effective.cache,
        staleEntry:
          cacheEnabled && cacheKey ? storage.get(cacheKey) : undefined,
        storage,
      });

    if (dedupeEnabled && dedupeKey) {
      const existing = inflight.get(dedupeKey);

      if (existing) {
        return cloneResponse(await existing);
      }

      const promise = operation().finally(() => {
        inflight.delete(dedupeKey);
      });

      inflight.set(dedupeKey, promise);
      return cloneResponse(await promise);
    }

    return operation();
  };

  const client = instance as AxiosRetryCacheInstance;

  client.retryCache = {
    async get(key) {
      return storage.get(key);
    },
    async set(key, response, setOptions = {}) {
      const now = Date.now();
      await storage.set(key, {
        key,
        createdAt: now,
        expiresAt:
          now + (setOptions.ttl ?? normalizeCacheOptions(options.cache).ttl),
        response: snapshotResponse(response),
      });
    },
    async invalidate(key) {
      return storage.delete(key);
    },
    async invalidatePrefix(prefix) {
      return deletePrefix(storage, prefix);
    },
    async clear() {
      await storage.clear();
    },
  };

  return client;
}

async function runOperation(input: {
  adapter: AxiosAdapter;
  config: InternalAxiosRequestConfig;
  cacheKey?: string;
  cacheEnabled: boolean;
  retry: RetryOptions | false;
  cache: CacheOptions | false;
  staleEntry?: CacheEntry | Promise<CacheEntry | undefined>;
  storage: RetryCacheStorage;
}): Promise<AxiosResponse> {
  const staleEntry = await input.staleEntry;
  let attempt = 1;
  let lastError: unknown;

  while (true) {
    try {
      const response = await input.adapter(input.config);
      const retryOptions = input.retry;
      const retry = retryOptions
        ? await shouldRetry(
            {
              attempt,
              retries: retryOptions.retries,
              config: input.config,
              response,
            },
            retryOptions,
          )
        : false;

      if (retry && retryOptions) {
        await sleep(
          await retryDelay(
            {
              attempt,
              retries: retryOptions.retries,
              config: input.config,
              response,
            },
            retryOptions,
          ),
        );
        attempt += 1;
        continue;
      }

      if (
        input.cacheEnabled &&
        input.cacheKey &&
        input.cache &&
        (await shouldCache(input.cacheKey, input.config, response, input.cache))
      ) {
        const now = Date.now();
        await input.storage?.set(input.cacheKey, {
          key: input.cacheKey,
          createdAt: now,
          expiresAt: now + input.cache.ttl,
          response: snapshotResponse(response),
        });
      }

      return response;
    } catch (error) {
      lastError = error;

      const axiosError = error as AxiosError | undefined;
      const errorResponse = axiosError?.response;
      const retryOptions = input.retry;
      const retry = retryOptions
        ? await shouldRetry(
            {
              attempt,
              retries: retryOptions.retries,
              config: input.config,
              response: errorResponse,
              error: error instanceof Error ? error : undefined,
            },
            retryOptions,
          )
        : false;

      if (retry && retryOptions) {
        await sleep(
          await retryDelay(
            {
              attempt,
              retries: retryOptions.retries,
              config: input.config,
              response: errorResponse,
              error: error instanceof Error ? error : undefined,
            },
            retryOptions,
          ),
        );
        attempt += 1;
        continue;
      }

      if (
        input.cache &&
        input.cache.staleIfError &&
        staleEntry &&
        !isFresh(staleEntry)
      ) {
        return responseFromCache(staleEntry, input.config);
      }

      throw lastError;
    }
  }
}

function resolveEffectiveOptions(
  globalOptions: RetryCacheOptions,
  requestOptions?: boolean | RetryCacheRequestOptions,
): {
  cache: CacheOptions | false;
  retry: RetryOptions | false;
  dedupe: boolean;
} {
  const requestOverrides =
    requestOptions === true
      ? { cache: true, retry: true }
      : typeof requestOptions === "object"
        ? requestOptions
        : undefined;
  const cache = resolveCacheOptions(
    globalOptions.cache,
    requestOverrides?.cache,
  );
  const retry = resolveRetryOptions(
    globalOptions.retry,
    requestOverrides?.retry,
  );

  return {
    cache,
    retry,
    dedupe: requestOverrides?.dedupe ?? globalOptions.dedupe ?? true,
  };
}

function resolveCacheOptions(
  globalCache: RetryCacheOptions["cache"],
  requestCache: RetryCacheRequestOptions["cache"],
): CacheOptions | false {
  if (requestCache === false) {
    return false;
  }

  if (requestCache === true) {
    return {
      ...normalizeCacheOptions(globalCache),
      enabled: true,
    };
  }

  if (
    globalCache === false &&
    (typeof requestCache !== "object" || requestCache.enabled !== true)
  ) {
    return false;
  }

  const cache = {
    ...normalizeCacheOptions(globalCache),
    ...definedOptions(requestCache),
  };

  return cache.enabled === false ? false : cache;
}

function resolveRetryOptions(
  globalRetry: RetryCacheOptions["retry"],
  requestRetry: RetryCacheRequestOptions["retry"],
): RetryOptions | false {
  if (requestRetry === false) {
    return false;
  }

  if (requestRetry === true) {
    return {
      ...normalizeRetryOptions(globalRetry),
      enabled: true,
    };
  }

  if (
    globalRetry === false &&
    (typeof requestRetry !== "object" || requestRetry.enabled !== true)
  ) {
    return false;
  }

  const retry = {
    ...normalizeRetryOptions(globalRetry),
    ...definedOptions(requestRetry),
  };

  return retry.enabled === false ? false : retry;
}

function normalizeCacheOptions(
  cache: RetryCacheOptions["cache"],
): CacheOptions {
  return {
    ...DEFAULT_CACHE,
    ...definedOptions(cache),
  };
}

function normalizeRetryOptions(
  retry: RetryCacheOptions["retry"],
): RetryOptions {
  return {
    ...DEFAULT_RETRY,
    ...definedOptions(retry),
  };
}

function definedOptions<T extends object>(
  options: T | false | undefined,
): Partial<T> {
  if (!options) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function shouldCache(
  key: string,
  config: InternalAxiosRequestConfig,
  response: AxiosResponse,
  cache: CacheOptions,
): Promise<boolean> | boolean {
  return cache.shouldCache?.({ key, config, response }) ?? true;
}

function methodAllowed(method: string, methods: string[] | undefined): boolean {
  return (
    !methods || methods.map((value) => value.toLowerCase()).includes(method)
  );
}

function isFresh(entry: CacheEntry): boolean {
  return entry.expiresAt > Date.now();
}
