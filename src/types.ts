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
}

export interface CacheOptions {
  enabled?: boolean;
  ttl: number;
  methods?: string[];
  staleIfError?: boolean;
  maxStaleAge?: number;
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
  requestKey?: RetryCacheRequestKey;
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
