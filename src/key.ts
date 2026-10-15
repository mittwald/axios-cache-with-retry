import type { InternalAxiosRequestConfig } from "axios";
import { cyrb128 } from "./hash.js";
import { touch, trim } from "./lru.js";
import type {
  CachedRequest,
  DefaultRequestKeyOptions,
  RetryCacheRequestKey,
} from "./types.js";

const METHODS_WITHOUT_BODY = ["get", "head"];

const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

const MAX_DIGESTS = 1024;

const digests = new Map<string, string>();

export async function resolveRequestKey(
  key: RetryCacheRequestKey | undefined,
  config: InternalAxiosRequestConfig,
  options: DefaultRequestKeyOptions = {},
): Promise<string | undefined> {
  if (typeof key === "function") {
    return key({ config });
  }

  return defaultRequestKey(config, options);
}

export function defaultRequestKey(
  config: InternalAxiosRequestConfig,
  options: DefaultRequestKeyOptions = {},
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

  const segments = [method, baseURL, url, params, data];
  const credentials = serializeCredentials(config, options.authHeaders);

  if (credentials !== undefined) {
    segments.push(digestOf(credentials));
  }

  return segments.join(" ");
}

function serializeCredentials(
  config: InternalAxiosRequestConfig,
  authHeaders: string[] = [],
): string | undefined {
  const names = [
    ...CREDENTIAL_HEADERS,
    ...authHeaders.map((name) => name.toLowerCase()),
  ];
  const credentials = Object.entries(config.headers ?? {})
    .filter(
      ([name, value]) => names.includes(name.toLowerCase()) && hasValue(value),
    )
    .map(([name, value]) => JSON.stringify([name.toLowerCase(), value]));

  if (
    config.auth &&
    (hasValue(config.auth.username) || hasValue(config.auth.password))
  ) {
    credentials.push(
      JSON.stringify(["auth", config.auth.username, config.auth.password]),
    );
  }

  return credentials.length === 0 ? undefined : credentials.sort().join("\n");
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasValue);
  }

  return (
    value !== undefined && value !== null && value !== false && value !== ""
  );
}

function digestOf(credentials: string): string {
  const digest = digests.get(credentials) ?? cyrb128(credentials);

  touch(digests, credentials, digest);
  trim(digests, MAX_DIGESTS);

  return digest;
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
