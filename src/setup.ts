import axios, { type AxiosAdapter, type AxiosInstance } from "axios";
import { withCache } from "./cache.js";
import { type InflightRequests, withDedupe } from "./dedupe.js";
import { resolveRequestKey } from "./key.js";
import { snapshotResponse } from "./response.js";
import { DEFAULT_RETRY_STATUS, withRetry } from "./retry.js";
import { createMemoryStorage, deletePrefix } from "./storage.js";
import type {
  AxiosRetryCacheInstance,
  CacheOptions,
  RetryCacheOptions,
  RetryCacheRequestOptions,
  RetryOptions,
} from "./types.js";

const DEFAULT_CACHE: CacheOptions = {
  enabled: true,
  ttl: 60_000,
  methods: ["get", "head"],
  staleIfError: false,
};

const SAFE_METHODS = ["get", "head", "options"];

const DEFAULT_RETRY: RetryOptions = {
  enabled: true,
  retries: 2,
  methods: [...SAFE_METHODS],
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
  const inflight: InflightRequests = new Map();

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
    const dedupeEnabled =
      effective.dedupe !== false &&
      (cacheEnabled || SAFE_METHODS.includes(method));
    const requestKey = await resolveRequestKey(options.requestKey, config);

    if (!cacheEnabled && !retryEnabled) {
      return originalAdapter(config);
    }

    let adapter = withRetry(originalAdapter, effective.retry);

    if (cacheEnabled && effective.cache && requestKey) {
      adapter = withCache(adapter, {
        key: requestKey,
        cache: effective.cache,
        storage,
      });
    }

    if (dedupeEnabled && requestKey) {
      adapter = withDedupe(adapter, inflight, requestKey);
    }

    return adapter(config);
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

function methodAllowed(method: string, methods: string[] | undefined): boolean {
  return (
    !methods || methods.map((value) => value.toLowerCase()).includes(method)
  );
}
