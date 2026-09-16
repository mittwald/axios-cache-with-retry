import { AxiosError, AxiosHeaders } from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRY_STATUS,
  retryDelay,
  shouldRetry,
  sleep,
} from "../src/retry.js";
import type { RetryDecisionContext, RetryOptions } from "../src/types.js";

function config(
  overrides: Partial<InternalAxiosRequestConfig> = {},
): InternalAxiosRequestConfig {
  return {
    ...overrides,
    headers: overrides.headers ?? new AxiosHeaders(),
  };
}

function context(
  overrides: Partial<RetryDecisionContext> = {},
): RetryDecisionContext {
  return {
    attempt: 1,
    retries: 2,
    config: config({ method: "get", url: "/users" }),
    ...overrides,
  };
}

function options(overrides: Partial<RetryOptions> = {}): RetryOptions {
  return { retries: 2, ...overrides };
}

function responseWith(status: number, headers: Record<string, string> = {}) {
  return {
    data: undefined,
    status,
    statusText: String(status),
    headers,
    config: config(),
    request: undefined,
  };
}

describe("shouldRetry", () => {
  it("stops once the attempt budget is spent", async () => {
    await expect(
      shouldRetry(
        context({ attempt: 3, response: responseWith(503) }),
        options({ retries: 2 }),
      ),
    ).resolves.toBe(false);
    await expect(
      shouldRetry(
        context({ attempt: 2, response: responseWith(503) }),
        options({ retries: 2 }),
      ),
    ).resolves.toBe(true);
  });

  it("enforces the budget before consulting a custom predicate", async () => {
    const shouldRetryOption = vi.fn(() => true);

    await expect(
      shouldRetry(
        context({ attempt: 3 }),
        options({ retries: 2, shouldRetry: shouldRetryOption }),
      ),
    ).resolves.toBe(false);
    expect(shouldRetryOption).not.toHaveBeenCalled();
  });

  it("lets a custom predicate replace the method and status checks", async () => {
    await expect(
      shouldRetry(
        context({
          config: config({ method: "post", url: "/submit" }),
          response: responseWith(404),
        }),
        options({ methods: ["get"], shouldRetry: () => true }),
      ),
    ).resolves.toBe(true);
  });

  it("refuses methods outside the allow list", async () => {
    await expect(
      shouldRetry(
        context({
          config: config({ method: "POST", url: "/submit" }),
          response: responseWith(503),
        }),
        options({ methods: ["get", "HEAD"] }),
      ),
    ).resolves.toBe(false);
    await expect(
      shouldRetry(
        context({
          config: config({ method: "HEAD", url: "/users" }),
          response: responseWith(503),
        }),
        options({ methods: ["get", "head"] }),
      ),
    ).resolves.toBe(true);
  });

  it("retries every default status and nothing else", async () => {
    for (const status of DEFAULT_RETRY_STATUS) {
      await expect(
        shouldRetry(context({ response: responseWith(status) }), options()),
      ).resolves.toBe(true);
    }

    for (const status of [200, 400, 404, 501]) {
      await expect(
        shouldRetry(context({ response: responseWith(status) }), options()),
      ).resolves.toBe(false);
    }
  });

  it("honours a narrowed retryOnStatus list", async () => {
    await expect(
      shouldRetry(
        context({ response: responseWith(500) }),
        options({ retryOnStatus: [429] }),
      ),
    ).resolves.toBe(false);
    await expect(
      shouldRetry(
        context({ response: responseWith(429) }),
        options({ retryOnStatus: [429] }),
      ),
    ).resolves.toBe(true);
  });

  it("retries an error that never produced a response", async () => {
    const error = new AxiosError("Network Error", AxiosError.ERR_NETWORK);

    await expect(shouldRetry(context({ error }), options())).resolves.toBe(
      true,
    );
    await expect(
      shouldRetry(context({ error }), options({ retryOnNetworkError: false })),
    ).resolves.toBe(false);
  });

  it("does not treat an error carrying a response as a network error", async () => {
    const error = new AxiosError(
      "Request failed",
      undefined,
      undefined,
      undefined,
      responseWith(404),
    );

    await expect(shouldRetry(context({ error }), options())).resolves.toBe(
      false,
    );
  });

  it("does not retry when there is neither a response nor an error", async () => {
    await expect(shouldRetry(context(), options())).resolves.toBe(false);
  });
});

describe("retryDelay", () => {
  it("backs off exponentially from 100ms and caps at 30s", async () => {
    await expect(retryDelay(context({ attempt: 1 }), options())).resolves.toBe(
      100,
    );
    await expect(retryDelay(context({ attempt: 2 }), options())).resolves.toBe(
      200,
    );
    await expect(retryDelay(context({ attempt: 4 }), options())).resolves.toBe(
      800,
    );
    await expect(retryDelay(context({ attempt: 20 }), options())).resolves.toBe(
      30_000,
    );
  });

  it("uses a fixed delay and an awaited function delay", async () => {
    await expect(retryDelay(context(), options({ delay: 42 }))).resolves.toBe(
      42,
    );
    await expect(
      retryDelay(
        context({ attempt: 3 }),
        options({ delay: async ({ attempt }) => attempt * 10 }),
      ),
    ).resolves.toBe(30);
  });

  it("lets Retry-After win over a configured delay", async () => {
    const delay = vi.fn(() => 5_000);

    await expect(
      retryDelay(
        context({ response: responseWith(429, { "retry-after": "2" }) }),
        options({ delay, respectRetryAfter: true }),
      ),
    ).resolves.toBe(2_000);
    expect(delay).not.toHaveBeenCalled();
  });

  it("ignores Retry-After when respectRetryAfter is off", async () => {
    await expect(
      retryDelay(
        context({ response: responseWith(429, { "retry-after": "2" }) }),
        options({ delay: 10, respectRetryAfter: false }),
      ),
    ).resolves.toBe(10);
  });

  it("reads Retry-After as an HTTP date", async () => {
    const delay = await retryDelay(
      context({
        response: responseWith(503, {
          "retry-after": new Date(Date.now() + 5_000).toUTCString(),
        }),
      }),
      options({ respectRetryAfter: true }),
    );

    expect(delay).toBeGreaterThan(3_000);
    expect(delay).toBeLessThanOrEqual(5_000);
  });

  it("never returns a negative delay for a date in the past", async () => {
    await expect(
      retryDelay(
        context({
          response: responseWith(503, {
            "retry-after": new Date(Date.now() - 60_000).toUTCString(),
          }),
        }),
        options({ respectRetryAfter: true }),
      ),
    ).resolves.toBe(0);
  });

  it("falls back to the backoff for an unparsable Retry-After", async () => {
    await expect(
      retryDelay(
        context({
          attempt: 1,
          response: responseWith(503, { "retry-after": "soon" }),
        }),
        options({ respectRetryAfter: true }),
      ),
    ).resolves.toBe(100);
  });
});

describe("sleep", () => {
  it("resolves without a timer for a non-positive duration", async () => {
    vi.useFakeTimers();

    try {
      await expect(sleep(0)).resolves.toBeUndefined();
      await expect(sleep(-1)).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the given duration", async () => {
    const started = Date.now();
    await sleep(15);

    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});
