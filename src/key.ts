import type { InternalAxiosRequestConfig } from "axios";
import type { CachedRequest, RetryCacheRequestKey } from "./types.js";

const METHODS_WITHOUT_BODY = ["get", "head"];

export async function resolveRequestKey(
  key: RetryCacheRequestKey | undefined,
  config: InternalAxiosRequestConfig,
): Promise<string | undefined> {
  if (typeof key === "function") {
    return key({ config });
  }

  return defaultRequestKey(config);
}

export function defaultRequestKey(
  config: InternalAxiosRequestConfig,
): string | undefined {
  const method = (config.method ?? "get").toLowerCase();
  const baseURL = config.baseURL ?? "";
  const url = config.url ?? "";
  const params = stableSerialize(config.params);
  const data = METHODS_WITHOUT_BODY.includes(method)
    ? ""
    : stableSerialize(config.data);

  if (!url) {
    return undefined;
  }

  return [method, baseURL, url, params, data].join(" ");
}

export function describeRequest(
  config: InternalAxiosRequestConfig,
): CachedRequest {
  return {
    method: (config.method ?? "get").toLowerCase(),
    ...(config.url === undefined ? {} : { url: config.url }),
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
  };
}

export function stableSerialize(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (isURLSearchParams(value)) {
    return serializeURLSearchParams(value);
  }

  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = sortValue(value[key]);
      return accumulator;
    }, {});
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && value.constructor === Object
  );
}

function isURLSearchParams(value: unknown): value is URLSearchParams {
  return (
    typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams
  );
}

function serializeURLSearchParams(params: URLSearchParams): string {
  return JSON.stringify(
    Array.from(params.entries()).sort(
      ([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyComparison = leftKey.localeCompare(rightKey);

        if (keyComparison !== 0) {
          return keyComparison;
        }

        return leftValue.localeCompare(rightValue);
      },
    ),
  );
}
