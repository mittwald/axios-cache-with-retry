import type {
  AxiosAdapter,
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
  delay?: number | ((context: RetryDelayContext) => Awaitable<number>);
  shouldRetry?: (context: RetryDecisionContext) => Awaitable<boolean>;
}

export interface RetryCacheRequestOptions {
  cache?: boolean | Partial<CacheOptions>;
  retry?: boolean | Partial<RetryOptions>;
  dedupe?: boolean;
}

export interface RetryCacheOptions {
  requestKey?: RetryCacheRequestKey;
  cache?: false | Partial<CacheOptions>;
  retry?: false | Partial<RetryOptions>;
  dedupe?: boolean;
  storage?: RetryCacheStorage;
}

export interface CachedResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface CacheEntry<T = unknown> {
  key: string;
  createdAt: number;
  expiresAt: number;
  response: CachedResponse<T>;
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
  clear(): Promise<void>;
}

export type AxiosRetryCacheInstance = AxiosInstance & {
  retryCache: RetryCacheApi;
};

export type AdapterFactory = (adapter: AxiosAdapter) => AxiosAdapter;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars --
   a declaration merge only applies when the type parameter list repeats Axios'
   own one verbatim, unused and `any` included */
declare module "axios" {
  export interface AxiosRequestConfig<D = any> {
    retryCache?: boolean | RetryCacheRequestOptions;
  }
}
