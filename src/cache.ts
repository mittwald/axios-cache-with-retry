import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import type { Flights } from "./flights.js";
import { responseFromCache, snapshotResponse } from "./response.js";
import type { CacheEntry, CacheOptions, RetryCacheStorage } from "./types.js";

export interface CacheLayerOptions {
  key: string;
  cache: CacheOptions;
  storage: RetryCacheStorage;
  flights: Flights;
}

export function withCache(
  adapter: AxiosAdapter,
  { key, cache, storage, flights }: CacheLayerOptions,
): AxiosAdapter {
  return async (config) => {
    const entry = await readEntry(storage, key);

    if (entry && isFresh(entry)) {
      return responseFromCache(entry, config);
    }

    const flight = flights.track(key);

    try {
      let response: AxiosResponse;

      try {
        response = await adapter(config);
      } catch (error) {
        if (cache.staleIfError && entry) {
          return responseFromCache(entry, config);
        }

        throw error;
      }

      if (
        (await isCacheable(key, config, response, cache)) &&
        !flight.detached
      ) {
        const now = Date.now();
        await writeEntry(storage, key, {
          key,
          createdAt: now,
          expiresAt: now + cache.ttl,
          response: snapshotResponse(response),
        });
      }

      return response;
    } finally {
      flight.land();
    }
  };
}

async function readEntry(
  storage: RetryCacheStorage,
  key: string,
): Promise<CacheEntry | undefined> {
  try {
    return await storage.get(key);
  } catch {
    return undefined;
  }
}

async function writeEntry(
  storage: RetryCacheStorage,
  key: string,
  entry: CacheEntry,
): Promise<boolean> {
  try {
    await storage.set(key, entry);
    return true;
  } catch {
    return false;
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
