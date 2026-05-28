import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import type { CacheEntry, CachedResponse } from "./types.js";

export function snapshotResponse(response: AxiosResponse): CachedResponse {
  return {
    data: response.data,
    status: response.status,
    statusText: response.statusText,
    headers: normalizeHeaders(response.headers),
  };
}

export function responseFromCache(
  entry: CacheEntry,
  config: InternalAxiosRequestConfig,
): AxiosResponse {
  return {
    data: entry.response.data,
    status: entry.response.status,
    statusText: entry.response.statusText,
    headers: { ...entry.response.headers },
    config,
    request: undefined,
  };
}

export function cloneResponse(response: AxiosResponse): AxiosResponse {
  return {
    ...response,
    headers: { ...response.headers },
    config: { ...response.config },
  };
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }

    output[key.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : String(value);
  }

  return output;
}
