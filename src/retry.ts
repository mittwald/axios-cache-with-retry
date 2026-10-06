import {
  type AxiosAdapter,
  type AxiosError,
  type AxiosResponse,
  CanceledError,
  type GenericAbortSignal,
  isCancel,
} from "axios";
import type {
  RetryDecisionContext,
  RetryDelayContext,
  RetryOptions,
} from "./types.js";

export const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];

type Outcome = { response: AxiosResponse } | { error: unknown };

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
      let outcome: Outcome;

      try {
        outcome = { response: await adapter(config) };
      } catch (error) {
        outcome = { error };
      }

      const error = "error" in outcome ? outcome.error : undefined;
      const context: RetryDecisionContext = {
        attempt,
        retries: retry.retries,
        config,
        response:
          "error" in outcome
            ? (outcome.error as AxiosError | undefined)?.response
            : outcome.response,
        error: error instanceof Error ? error : undefined,
      };

      if (!(await shouldRetry(context, retry))) {
        if ("error" in outcome) {
          throw outcome.error;
        }

        return outcome.response;
      }

      await sleep(await retryDelay(context, retry), config.signal);
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

export async function retryDelay(
  context: RetryDelayContext,
  retry: RetryOptions,
): Promise<number> {
  const retryAfter = retry.respectRetryAfter
    ? parseRetryAfter(context.response?.headers?.["retry-after"])
    : undefined;

  if (retryAfter !== undefined) {
    return retryAfter;
  }

  if (typeof retry.delay === "number") {
    return retry.delay;
  }

  if (typeof retry.delay === "function") {
    return retry.delay(context);
  }

  return Math.min(100 * 2 ** Math.max(context.attempt - 1, 0), 30_000);
}

export function sleep(ms: number, signal?: GenericAbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new CanceledError());
  }

  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new CanceledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", abort);
      resolve();
    }, ms);

    signal?.addEventListener?.("abort", abort);
  });
}

function isRetryableNetworkError(
  error: RetryDecisionContext["error"],
): boolean {
  if (!error) {
    return false;
  }

  const maybeAxiosError = error as AxiosError;

  if (maybeAxiosError.response) {
    return false;
  }

  return true;
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
