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

const CREDENTIAL_PARAMS = ["access_token"];

const MAX_DIGESTS = 1024;

const digests = new Map<string, string>();

export async function resolveRequestKey(
  key: RetryCacheRequestKey | undefined,
  config: InternalAxiosRequestConfig,
  options: DefaultRequestKeyOptions = {},
): Promise<string | undefined> {
  if (typeof key === "function") {
    return key({
      config,
      authHeaders: options.authHeaders ?? [],
      authParams: options.authParams ?? [],
    });
  }

  return defaultRequestKey(config, options);
}

export function defaultRequestKey(
  config: InternalAxiosRequestConfig,
  options: DefaultRequestKeyOptions = {},
): string | undefined {
  if (!config.url) {
    return undefined;
  }

  const method = (config.method ?? "get").toLowerCase();
  const paramNames = withDefaults(CREDENTIAL_PARAMS, options.authParams);
  const credentials: string[] = [];
  const baseURL = stripUrlCredentials(
    config.baseURL ?? "",
    paramNames,
    credentials,
  );
  const url = stripUrlCredentials(config.url, paramNames, credentials);
  const params = stableSerialize(
    stripParamCredentials(config.params, paramNames, credentials),
  );
  const data = METHODS_WITHOUT_BODY.includes(method)
    ? ""
    : stableSerialize(config.data);

  collectCredentials(config, options, credentials);

  const segments = [method, baseURL, url, params, data];

  if (credentials.length > 0) {
    segments.push(digestOf(credentials.sort().join("\n")));
  }

  return segments.join(" ");
}

const mergedNames = new WeakMap<
  readonly string[],
  WeakMap<readonly string[], readonly string[]>
>();

/**
 * The default names plus the given ones; computed once per default list for a
 * frozen list, which is what setupAxiosRetryCache passes for every request
 */
function withDefaults(
  defaults: readonly string[],
  names: readonly string[] | undefined,
  normalize: (name: string) => string = (name) => name,
): readonly string[] {
  if (!names || names.length === 0) {
    return defaults;
  }

  const memo = Object.isFrozen(names)
    ? (mergedNames.get(defaults) ?? new WeakMap())
    : undefined;
  const known = memo?.get(names);

  if (known) {
    return known;
  }

  const all = [...defaults, ...names.map(normalize)];

  if (memo) {
    memo.set(names, all);
    mergedNames.set(defaults, memo);
  }

  return all;
}

function collectCredentials(
  config: InternalAxiosRequestConfig,
  options: DefaultRequestKeyOptions,
  credentials: string[],
): void {
  const headerNames = withDefaults(
    CREDENTIAL_HEADERS,
    options.authHeaders,
    (name) => name.toLowerCase(),
  );

  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (headerNames.includes(name.toLowerCase()) && hasValue(value)) {
      credentials.push(JSON.stringify([name.toLowerCase(), value]));
    }
  }

  if (
    config.auth &&
    (hasValue(config.auth.username) || hasValue(config.auth.password))
  ) {
    credentials.push(
      JSON.stringify(["auth", config.auth.username, config.auth.password]),
    );
  }

  const proxyAuth = config.proxy ? config.proxy.auth : undefined;

  if (
    proxyAuth &&
    (hasValue(proxyAuth.username) || hasValue(proxyAuth.password))
  ) {
    credentials.push(
      JSON.stringify({ proxyAuth: [proxyAuth.username, proxyAuth.password] }),
    );
  }
}

/** Moves the userinfo and the credential params of a URL into `credentials` */
function stripUrlCredentials(
  value: string,
  paramNames: readonly string[],
  credentials: string[],
): string {
  return stripQueryCredentials(
    stripUserinfo(value, credentials),
    paramNames,
    credentials,
  );
}

function stripUserinfo(value: string, credentials: string[]): string {
  const authority = /^((?:[a-z][a-z\d+.-]*:)?\/\/)([^/?#]*)/i.exec(value);
  const at = authority?.[2]?.lastIndexOf("@") ?? -1;

  if (!authority || at === -1) {
    return value;
  }

  const [prefix, scheme, hostPart] = authority as unknown as [
    string,
    string,
    string,
  ];
  const userinfo = hostPart.slice(0, at);

  if (userinfo) {
    credentials.push(JSON.stringify({ userinfo }));
  }

  return scheme + hostPart.slice(at + 1) + value.slice(prefix.length);
}

function stripQueryCredentials(
  value: string,
  paramNames: readonly string[],
  credentials: string[],
): string {
  const queryStart = value.indexOf("?");

  if (queryStart === -1) {
    return value;
  }

  const hashStart = value.indexOf("#", queryStart);
  const queryEnd = hashStart === -1 ? value.length : hashStart;
  const pairs = value.slice(queryStart + 1, queryEnd).split("&");
  const kept = pairs.filter((pair) => {
    const separator = pair.indexOf("=");
    const name = decode(separator === -1 ? pair : pair.slice(0, separator));
    const paramValue =
      separator === -1 ? "" : decode(pair.slice(separator + 1));

    if (!paramNames.includes(name) || !hasValue(paramValue)) {
      return true;
    }

    credentials.push(JSON.stringify({ param: [name, paramValue] }));
    return false;
  });

  if (kept.length === pairs.length) {
    return value;
  }

  const query = kept.join("&");

  return (
    value.slice(0, queryStart) +
    (query ? `?${query}` : "") +
    value.slice(queryEnd)
  );
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function stripParamCredentials(
  params: unknown,
  paramNames: readonly string[],
  credentials: string[],
): unknown {
  if (isURLSearchParams(params)) {
    const found = paramNames.filter((name) =>
      params.getAll(name).some(hasValue),
    );

    if (found.length === 0) {
      return params;
    }

    const rest = new URLSearchParams(params);

    for (const name of found) {
      for (const value of rest.getAll(name).filter(hasValue)) {
        credentials.push(JSON.stringify({ param: [name, value] }));
      }

      rest.delete(name);
    }

    return rest;
  }

  if (!isPlainRecord(params)) {
    return params;
  }

  const found = paramNames.filter((name) => hasValue(params[name]));

  if (found.length === 0) {
    return params;
  }

  const rest = { ...params };

  for (const name of found) {
    credentials.push(JSON.stringify({ param: [name, rest[name]] }));
    delete rest[name];
  }

  return rest;
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
