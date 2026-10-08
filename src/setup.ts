import axios, { type AxiosAdapter, type AxiosInstance } from "axios";
import { entryLifetime, withCache } from "./cache.js";
import { type InflightRequests, withDedupe } from "./dedupe.js";
import { describeRequest, resolveRequestKey } from "./key.js";
import { snapshotResponse } from "./response.js";
import { DEFAULT_MAX_DELAY, DEFAULT_RETRY_STATUS, withRetry } from "./retry.js";
import { createMemoryStorage, deletePrefix, deleteWhere } from "./storage.js";
import { flightsFor } from "./flights.js";
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
  maxDelay: DEFAULT_MAX_DELAY,
};

const installedAdapters = new WeakMap<AxiosInstance, AxiosAdapter>();

export function setupAxiosRetryCache(
  instance: AxiosInstance,
  options: RetryCacheOptions = {},
): AxiosRetryCacheInstance {
  assertValidRetry(options.retry);
  const storage = options.storage ?? createMemoryStorage();
  const originalAdapter =
    installedAdapters.get(instance) ??
    axios.getAdapter(instance.defaults.adapter);
  const inflight: InflightRequests = new Map();
  const flights = flightsFor(storage);

  installedAdapters.set(instance, originalAdapter);

  instance.defaults.adapter = async (config) => {
    const requestOptions = config.retryCache;

    if (requestOptions === false) {
      return originalAdapter(config);
    }

    const effective = resolveEffectiveOptions(options, requestOptions);
    const method = (config.method ?? "get").toLowerCase();
    const cache =
      effective.cache && methodAllowed(method, effective.cache.methods)
        ? effective.cache
        : undefined;
    const dedupeEnabled =
      effective.dedupe !== false &&
      (cache !== undefined || SAFE_METHODS.includes(method));
    const requestKey = await resolveRequestKey(options.requestKey, config);

    if (!cache && !effective.retry) {
      return originalAdapter(config);
    }

    let adapter = withRetry(originalAdapter, effective.retry);

    if (cache && requestKey) {
      adapter = withCache(adapter, {
        key: requestKey,
        cache,
        storage,
        flights,
        onStorageError: options.onStorageError,
      });
    }

    if (dedupeEnabled && requestKey) {
      adapter = withDedupe(adapter, inflight, requestKey, flights);
    }

    return adapter(config);
  };

  const client = instance as AxiosRetryCacheInstance;

  client.retryCache = {
    async get(key) {
      return storage.get(key);
    },
    async set(key, response, setOptions = {}) {
      const cache = normalizeCacheOptions(options.cache);
      await storage.set(key, {
        key,
        ...entryLifetime(cache, setOptions.ttl),
        response: snapshotResponse(response),
        ...(response.config
          ? { request: describeRequest(response.config) }
          : {}),
      });
    },
    async invalidate(key) {
      flights.detach((target) => target.key === key);
      return storage.delete(key);
    },
    async invalidatePrefix(prefix) {
      flights.detach((target) => target.key.startsWith(prefix));
      return deletePrefix(storage, prefix);
    },
    async invalidateWhere(predicate) {
      flights.detach(predicate);
      return deleteWhere(storage, predicate);
    },
    async clear() {
      flights.detach(() => true);
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

  assertValidRetry(requestRetry);

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

function assertValidRetry(
  retry: RetryCacheOptions["retry"] | RetryCacheRequestOptions["retry"],
): void {
  const maxDelay = typeof retry === "object" ? retry.maxDelay : undefined;

  if (
    maxDelay !== undefined &&
    !(typeof maxDelay === "number" && maxDelay >= 0)
  ) {
    throw new TypeError(
      `retry.maxDelay must be a number >= 0 or Infinity, got ${String(maxDelay)}`,
    );
  }
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
