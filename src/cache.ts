import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import type { Flights } from "./flights.js";
import {
  cacheControlDirectives,
  matchesVary,
  varyFields,
  varyValues,
} from "./headers.js";
import { describeRequest } from "./key.js";
import { responseFromCache, snapshotResponse } from "./response.js";
import type {
  CacheEntry,
  CacheOptions,
  RetryCacheOptions,
  RetryCacheStorage,
  StorageErrorContext,
} from "./types.js";

export interface CacheLayerOptions {
  key: string;
  cache: CacheOptions;
  storage: RetryCacheStorage;
  flights: Flights;
  onStorageError?: RetryCacheOptions["onStorageError"];
}

export function withCache(
  adapter: AxiosAdapter,
  { key, cache, storage, flights, onStorageError }: CacheLayerOptions,
): AxiosAdapter {
  const report = (context: StorageErrorContext) =>
    reportStorageError(onStorageError, context);

  return async (config) => {
    let entry = await readEntry(storage, key, report);

    if (entry && isDead(entry)) {
      await deleteEntry(storage, key, report);
      entry = undefined;
    }

    if (
      entry &&
      cache.vary !== false &&
      !matchesVary(entry.vary, config.headers)
    ) {
      entry = undefined;
    }

    if (entry && isFresh(entry)) {
      return responseFromCache(entry, config);
    }

    const request = describeRequest(config);
    const flight = flights.track({ key, ...request });

    try {
      let response: AxiosResponse;

      try {
        response = await adapter(config);
      } catch (error) {
        if (cache.staleIfError && entry && !flight.detached && !isDead(entry)) {
          return responseFromCache(entry, config);
        }

        throw error;
      }

      const policy = storePolicy(response, config, cache);

      if (
        policy &&
        (await isCacheable(key, config, response, cache)) &&
        !flight.detached
      ) {
        await writeEntry(
          storage,
          key,
          {
            key,
            ...entryLifetime(cache, cache.ttl, policy.mustRevalidate),
            response: snapshotResponse(response),
            request,
            ...(policy.vary ? { vary: policy.vary } : {}),
          },
          report,
        );
      }

      return response;
    } finally {
      flight.land();
    }
  };
}

type Report = (context: StorageErrorContext) => void;

async function readEntry(
  storage: RetryCacheStorage,
  key: string,
  report: Report,
): Promise<CacheEntry | undefined> {
  try {
    return await storage.get(key);
  } catch (error) {
    report({ operation: "get", key, error });
    return undefined;
  }
}

async function deleteEntry(
  storage: RetryCacheStorage,
  key: string,
  report: Report,
): Promise<void> {
  try {
    await storage.delete(key);
  } catch (error) {
    report({ operation: "delete", key, error });
  }
}

async function writeEntry(
  storage: RetryCacheStorage,
  key: string,
  entry: CacheEntry,
  report: Report,
): Promise<void> {
  try {
    await storage.set(key, entry);
  } catch (error) {
    report({ operation: "set", key, error });
  }
}

function reportStorageError(
  onStorageError: RetryCacheOptions["onStorageError"],
  context: StorageErrorContext,
): void {
  try {
    const result: unknown = onStorageError?.(context);

    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
  } catch {
    return;
  }
}

/**
 * Whether the response headers allow storing it, and how; checked before
 * shouldCache, which can only narrow the decision
 */
function storePolicy(
  response: AxiosResponse,
  config: InternalAxiosRequestConfig,
  cache: CacheOptions,
): { mustRevalidate: boolean; vary?: CacheEntry["vary"] } | undefined {
  const directives = cacheControlDirectives(response.headers);
  const respect = cache.respectCacheControl !== false;

  if (respect && (directives.has("no-store") || directives.has("no-cache"))) {
    return undefined;
  }

  if (cache.shared && directives.has("private")) {
    return undefined;
  }

  const fields =
    cache.vary === false ? undefined : varyFields(response.headers);

  if (fields === "*") {
    return undefined;
  }

  return {
    vary: fields && varyValues(config.headers, fields),
    mustRevalidate:
      respect &&
      (directives.has("must-revalidate") ||
        (cache.shared === true && directives.has("proxy-revalidate"))),
  };
}

function isCacheable(
  key: string,
  config: InternalAxiosRequestConfig,
  response: AxiosResponse,
  cache: CacheOptions,
): Promise<boolean> | boolean {
  return (
    cache.shouldCache?.({ key, config, response }) ??
    (response.status >= 200 && response.status < 300)
  );
}

export function isFresh(entry: CacheEntry): boolean {
  return entry.expiresAt > Date.now();
}

export function isDead(entry: CacheEntry, now = Date.now()): boolean {
  return entry.staleUntil !== undefined && entry.staleUntil <= now;
}

export function entryLifetime(
  cache: CacheOptions,
  ttl = cache.ttl,
  mustRevalidate = false,
): Pick<CacheEntry, "createdAt" | "expiresAt" | "staleUntil"> {
  const createdAt = Date.now();
  const expiresAt = createdAt + ttl;

  if (!cache.staleIfError || mustRevalidate) {
    return { createdAt, expiresAt, staleUntil: expiresAt };
  }

  if (cache.maxStaleAge === undefined) {
    return { createdAt, expiresAt };
  }

  return { createdAt, expiresAt, staleUntil: expiresAt + cache.maxStaleAge };
}
