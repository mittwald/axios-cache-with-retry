import type {
  AxiosError,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

export type Awaitable<T> = T | Promise<T>;

export type RetryCacheRequestKey = (
  context: RequestKeyContext,
) => Awaitable<string | undefined>;

export interface RequestKeyContext {
  config: InternalAxiosRequestConfig;
  /** The `authHeaders` of the setup, to pass on to `defaultRequestKey` */
  authHeaders: readonly string[];
  /** The `authParams` of the setup, to pass on to `defaultRequestKey` */
  authParams: readonly string[];
}

export interface DefaultRequestKeyOptions {
  /**
   * Further headers that carry credentials, in addition to `Authorization`,
   * `Cookie` and `Proxy-Authorization`. Names are matched case-insensitively.
   */
  authHeaders?: readonly string[];
  /**
   * Further query parameters that carry credentials, in addition to
   * `access_token`, in `params` or in the query of the url. Names are matched
   * exactly.
   */
  authParams?: readonly string[];
}

export interface CacheOptions {
  enabled?: boolean;
  ttl: number;
  methods?: string[];
  staleIfError?: boolean;
  maxStaleAge?: number;
  /**
   * Honour `no-store` and `no-cache` (not stored) and `must-revalidate` (never
   * served stale) in the response, in a shared cache also `proxy-revalidate`
   * and `s-maxage`, `true` by default. It covers exactly these directives.
   */
  respectCacheControl?: boolean;
  /**
   * Honour the request's own `no-cache` and `max-age=0` (entry skipped) and
   * `no-store` (neither read nor stored), and keep such a request out of
   * merging, `false` by default, since clients often send `no-cache` only to
   * keep the browser's HTTP cache out.
   */
  respectRequestCacheControl?: boolean;
  /**
   * Whether the cache serves several users, so a `private` response is not
   * stored, also with `respectCacheControl: false`, and with
   * `respectCacheControl` on, `proxy-revalidate` and `s-maxage` keep an entry
   * from being served stale. By default `true` with the server defaults,
   * `false` otherwise.
   */
  shared?: boolean;
  /**
   * Serve an entry only to requests whose headers named in `Vary` match those
   * of the request it was stored for, and never store `Vary: *`; `true` by
   * default. Only headers in `config.headers` count.
   */
  vary?: boolean;
  shouldCache?: (context: CacheDecisionContext) => Awaitable<boolean>;
}

export interface CacheDecisionContext<T = unknown, D = unknown> {
  key: string;
  config: InternalAxiosRequestConfig<D>;
  response: AxiosResponse<T, D>;
}

export interface RetryDecisionContext<T = unknown, D = unknown> {
  attempt: number;
  retries: number;
  config: InternalAxiosRequestConfig<D>;
  response?: AxiosResponse<T, D>;
  error?: AxiosError<T, D> | Error;
}

export type RetryDelayContext<T = unknown, D = unknown> = RetryDecisionContext<
  T,
  D
>;

export interface RetryOptions {
  enabled?: boolean;
  retries: number;
  methods?: string[];
  retryOnStatus?: number[];
  retryOnNetworkError?: boolean;
  respectRetryAfter?: boolean;
  /**
   * Upper bound in milliseconds for every delay, 30 000 by default and
   * `Infinity` for none. A configured `delay` or the backoff is capped at it,
   * while a `Retry-After` above it ends the retries, even when `shouldRetry`
   * returns `true`. Anything but a number >= 0 throws.
   */
  maxDelay?: number;
  delay?: number | ((context: RetryDelayContext) => Awaitable<number>);
  shouldRetry?: (context: RetryDecisionContext) => Awaitable<boolean>;
}

export interface RetryCacheRequestOptions {
  cache?: boolean | Partial<CacheOptions>;
  retry?: boolean | Partial<RetryOptions>;
  dedupe?: boolean;
}

export interface StorageErrorContext {
  operation: "get" | "set" | "delete";
  key: string;
  error: unknown;
}

export interface RetryCacheOptions {
  /**
   * Which defaults apply: `"server"` keeps cache and dedupe off until they are
   * turned on, `"browser"` has them on. Without it, a missing `window` means
   * `"server"`. Anything else throws.
   */
  runtime?: "browser" | "server";
  requestKey?: RetryCacheRequestKey;
  /**
   * Further credential headers for the default key, for every request of this
   * instance. See {@link DefaultRequestKeyOptions.authHeaders}.
   */
  authHeaders?: DefaultRequestKeyOptions["authHeaders"];
  /**
   * Further credential query parameters for the default key, for every request
   * of this instance. See {@link DefaultRequestKeyOptions.authParams}.
   */
  authParams?: DefaultRequestKeyOptions["authParams"];
  cache?: false | Partial<CacheOptions>;
  retry?: false | Partial<RetryOptions>;
  dedupe?: boolean;
  storage?: RetryCacheStorage;
  onStorageError?: (context: StorageErrorContext) => void;
}

export interface CachedResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface CachedRequest {
  method: string;
  url?: string;
  baseURL?: string;
}

export interface CacheEntry<T = unknown> {
  key: string;
  createdAt: number;
  expiresAt: number;
  /** Last moment the entry may be served at all; without it, no limit */
  staleUntil?: number;
  response: CachedResponse<T>;
  request?: CachedRequest;
  /** Digests of the request headers named in `Vary`, `null` for an absent one */
  vary?: Record<string, string | null>;
}

export interface InvalidationTarget extends Partial<CachedRequest> {
  key: string;
}

export interface RetryCacheStorage<T = unknown> {
  get(key: string): Awaitable<CacheEntry<T> | undefined>;
  set(key: string, entry: CacheEntry<T>): Awaitable<void>;
  delete(key: string): Awaitable<boolean>;
  clear(): Awaitable<void>;
  keys?(): Awaitable<Iterable<string>>;
  deletePrefix?(prefix: string): Awaitable<number>;
}

export interface RetryCacheApi {
  get(key: string): Promise<CacheEntry | undefined>;
  set(
    key: string,
    response: AxiosResponse,
    options?: { ttl?: number },
  ): Promise<void>;
  invalidate(key: string): Promise<boolean>;
  invalidatePrefix(prefix: string): Promise<number>;
  invalidateWhere(
    predicate: (target: InvalidationTarget) => boolean,
  ): Promise<number>;
  clear(): Promise<void>;
}

export type AxiosRetryCacheInstance = AxiosInstance & {
  retryCache: RetryCacheApi;
};

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars --
   a declaration merge only applies when the type parameter list repeats Axios'
   own one verbatim, unused and `any` included */
declare module "axios" {
  export interface AxiosRequestConfig<D = any> {
    retryCache?: boolean | RetryCacheRequestOptions;
  }
}
