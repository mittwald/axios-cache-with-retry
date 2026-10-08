import {
  type AxiosAdapter,
  type AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
  isCancel,
} from "axios";
import { raceAbort } from "./abort.js";
import type {
  RetryDecisionContext,
  RetryDelayContext,
  RetryOptions,
} from "./types.js";

export const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];
export const DEFAULT_MAX_DELAY = 30_000;
const BACKOFF_CAP = 30_000;

export function withRetry(
  adapter: AxiosAdapter,
  retry: RetryOptions | false,
): AxiosAdapter {
  if (!retry) {
    return adapter;
  }

  return async (config) => {
    let attempt = 1;

    while (true) {
      let response: AxiosResponse | undefined;
      let error: unknown;

      try {
        response = await adapter(config);
      } catch (caught) {
        error = caught;
      }

      const context: RetryDecisionContext = {
        attempt,
        retries: retry.retries,
        config,
        response: response ?? responseOf(error),
        error: error instanceof Error ? error : undefined,
      };

      if (
        !(await shouldRetry(context, retry)) ||
        retryAfterExceedsMaxDelay(context, retry)
      ) {
        if (response) {
          return response;
        }

        throw error;
      }

      await sleep(await retryDelay(context, retry), config);
      attempt += 1;
    }
  };
}

export async function shouldRetry(
  context: RetryDecisionContext,
  retry: RetryOptions,
): Promise<boolean> {
  if (context.attempt > retry.retries || isCancel(context.error)) {
    return false;
  }

  if (retry.shouldRetry) {
    return retry.shouldRetry(context);
  }

  const method = (context.config.method ?? "get").toLowerCase();
  const allowedMethods = retry.methods?.map((value) => value.toLowerCase());

  if (allowedMethods && !allowedMethods.includes(method)) {
    return false;
  }

  if (context.response) {
    return (retry.retryOnStatus ?? DEFAULT_RETRY_STATUS).includes(
      context.response.status,
    );
  }

  return (
    retry.retryOnNetworkError !== false &&
    isRetryableNetworkError(context.error)
  );
}

/** A retry before the time the server asked for is expected to fail again */
export function retryAfterExceedsMaxDelay(
  context: RetryDelayContext,
  retry: RetryOptions,
): boolean {
  const retryAfter = retryAfterOf(context, retry);

  return retryAfter !== undefined && retryAfter > maxDelayOf(retry);
}

export async function retryDelay(
  context: RetryDelayContext,
  retry: RetryOptions,
): Promise<number> {
  const delay =
    retryAfterOf(context, retry) ?? (await configuredDelay(context, retry));

  return Math.min(delay, maxDelayOf(retry));
}

function retryAfterOf(
  context: RetryDelayContext,
  retry: RetryOptions,
): number | undefined {
  return retry.respectRetryAfter
    ? parseRetryAfter(context.response?.headers?.["retry-after"])
    : undefined;
}

function maxDelayOf(retry: RetryOptions): number {
  return retry.maxDelay ?? DEFAULT_MAX_DELAY;
}

async function configuredDelay(
  context: RetryDelayContext,
  retry: RetryOptions,
): Promise<number> {
  if (typeof retry.delay === "number") {
    return retry.delay;
  }

  if (typeof retry.delay === "function") {
    return retry.delay(context);
  }

  return Math.min(100 * 2 ** Math.max(context.attempt - 1, 0), BACKOFF_CAP);
}

export function sleep(
  ms: number,
  config: InternalAxiosRequestConfig,
): Promise<void> {
  if (ms <= 0) {
    return raceAbort(Promise.resolve(), config);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  return raceAbort(
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
    config,
    () => clearTimeout(timer),
  );
}

function isRetryableNetworkError(
  error: RetryDecisionContext["error"],
): boolean {
  return Boolean(error) && !responseOf(error);
}

function responseOf(error: unknown): AxiosResponse | undefined {
  return (error as AxiosError | undefined)?.response;
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, timestamp - Date.now());
}
