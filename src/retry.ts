import type { AxiosError } from "axios";
import type {
  RetryDecisionContext,
  RetryDelayContext,
  RetryOptions,
} from "./types.js";

export const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];

export async function shouldRetry(
  context: RetryDecisionContext,
  retry: RetryOptions,
): Promise<boolean> {
  if (context.attempt > retry.retries) {
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

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
