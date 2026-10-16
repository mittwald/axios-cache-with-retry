import axios, { type AxiosAdapter, type AxiosInstance } from "axios";
import {
  deleteEntry,
  entryLifetime,
  reportStorageError,
  requestedFreshness,
  withCache,
} from "./cache.js";
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
  respectCacheControl: true,
  respectRequestCacheControl: false,
  shared: false,
  vary: true,
};

const SAFE_METHODS = ["get", "head", "options"];

interface RuntimeDefaults {
  cache: CacheOptions;
  dedupe: boolean;
}

const BROWSER_DEFAULTS: RuntimeDefaults = {
  cache: DEFAULT_CACHE,
  dedupe: true,
};

const SERVER_DEFAULTS: RuntimeDefaults = {
  cache: { ...DEFAULT_CACHE, enabled: false, shared: true },
  dedupe: false,
};

interface ResolvedGlobals extends RetryCacheOptions {
  cache: CacheOptions;
  dedupe: boolean;
}

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
  assertValidRuntime(options.runtime);
  const runtime =
    options.runtime ?? (typeof window === "undefined" ? "server" : "browser");
  const runtimeDefaults =
    runtime === "server" ? SERVER_DEFAULTS : BROWSER_DEFAULTS;
  const resolvedGlobals: ResolvedGlobals = {
    ...options,
    cache:
      options.cache === false
        ? { ...runtimeDefaults.cache, enabled: false }
        : normalizeCacheOptions(options.cache, runtimeDefaults.cache),
    dedupe: options.dedupe ?? runtimeDefaults.dedupe,
  };
  const keyOptions = {
    authHeaders: Object.freeze([...(options.authHeaders ?? [])]),
    authParams: Object.freeze([...(options.authParams ?? [])]),
  };
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

    const effective = resolveEffectiveOptions(resolvedGlobals, requestOptions);
    const method = (config.method ?? "get").toLowerCase();
    const cache =
      effective.cache && methodAllowed(method, effective.cache.methods)
        ? effective.cache
        : undefined;
    const freshness = requestedFreshness(config, cache);
    const dedupeEnabled =
      effective.dedupe !== false &&
      !freshness.skipRead &&
      (cache !== undefined || SAFE_METHODS.includes(method));

    if (!cache && !effective.retry) {
      return originalAdapter(config);
    }

    const requestKey =
      cache || dedupeEnabled
        ? await resolveRequestKey(options.requestKey, config, keyOptions)
        : undefined;

    let adapter = withRetry(originalAdapter, effective.retry);

    if (cache && requestKey) {
      adapter = withCache(adapter, {
        key: requestKey,
        cache,
        freshness,
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
      const entry = await storage.get(key);
      return entry && !flights.hides(entry) ? entry : undefined;
    },
    async set(key, response, setOptions = {}) {
      const cache = resolvedGlobals.cache;
      const request = response.config
        ? describeRequest(response.config)
        : undefined;
      const flight = flights.track({ key, ...request });

      try {
        await storage.set(key, {
          key,
          ...entryLifetime(cache, setOptions.ttl),
          response: snapshotResponse(response),
          ...(request ? { request } : {}),
        });
        flights.wrote(flight, key, () =>
          deleteEntry(storage, key, (context) =>
            reportStorageError(options.onStorageError, context),
          ),
        );
      } finally {
        flight.land();
      }
    },
    async invalidate(key) {
      return flights.invalidate(
        (target) => target.key === key,
        () => storage.delete(key),
      );
    },
    async invalidatePrefix(prefix) {
      return flights.invalidate(
        (target) => target.key.startsWith(prefix),
        () => deletePrefix(storage, prefix),
      );
    },
    async invalidateWhere(predicate) {
      return flights.invalidate(predicate, () =>
        deleteWhere(storage, predicate),
      );
    },
    async clear() {
      await flights.invalidate(
        () => true,
        () => storage.clear(),
      );
    },
  };

  return client;
}

function resolveEffectiveOptions(
  globalOptions: ResolvedGlobals,
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
    dedupe: requestOverrides?.dedupe ?? globalOptions.dedupe,
  };
}

function resolveCacheOptions(
  globalCache: CacheOptions,
  requestCache: RetryCacheRequestOptions["cache"],
): CacheOptions | false {
  if (requestCache === false) {
    return false;
  }

  if (requestCache === true) {
    return { ...globalCache, enabled: true };
  }

  const cache = { ...globalCache, ...definedOptions(requestCache) };

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

function assertValidRuntime(runtime: RetryCacheOptions["runtime"]): void {
  if (runtime !== undefined && runtime !== "browser" && runtime !== "server") {
    throw new TypeError(
      `runtime must be "browser" or "server", got ${String(runtime)}`,
    );
  }
}

function normalizeCacheOptions(
  cache: RetryCacheOptions["cache"],
  base: CacheOptions,
): CacheOptions {
  return {
    ...base,
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
