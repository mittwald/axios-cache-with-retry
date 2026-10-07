import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import type { Flights } from "./flights.js";
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
    const entry = await readEntry(storage, key, report);

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
        if (cache.staleIfError && entry && !flight.detached) {
          return responseFromCache(entry, config);
        }

        throw error;
      }

      if (
        (await isCacheable(key, config, response, cache)) &&
        !flight.detached
      ) {
        const now = Date.now();
        await writeEntry(
          storage,
          key,
          {
            key,
            createdAt: now,
            expiresAt: now + cache.ttl,
            response: snapshotResponse(response),
            request,
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
