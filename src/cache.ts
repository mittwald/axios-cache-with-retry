import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import { responseFromCache, snapshotResponse } from "./response.js";
import type { CacheEntry, CacheOptions, RetryCacheStorage } from "./types.js";

export interface CacheLayerOptions {
  key: string;
  cache: CacheOptions;
  storage: RetryCacheStorage;
}

export function withCache(
  adapter: AxiosAdapter,
  { key, cache, storage }: CacheLayerOptions,
): AxiosAdapter {
  return async (config) => {
    const entry = await storage.get(key);

    if (entry && isFresh(entry)) {
      return responseFromCache(entry, config);
    }

    let response: AxiosResponse;

    try {
      response = await adapter(config);
    } catch (error) {
      if (cache.staleIfError && entry) {
        return responseFromCache(entry, config);
      }

      throw error;
    }

    if (await shouldCache(key, config, response, cache)) {
      const now = Date.now();
      await storage.set(key, {
        key,
        createdAt: now,
        expiresAt: now + cache.ttl,
        response: snapshotResponse(response),
      });
    }

    return response;
  };
}

function shouldCache(
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
