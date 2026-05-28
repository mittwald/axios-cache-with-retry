import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
} from "axios";
import { describe, expect, it, vi } from "vitest";
import { setupAxiosRetryCache } from "../src/index.js";

function response(
  config: AxiosResponse["config"],
  status: number,
  data: unknown = { ok: status < 400 },
): AxiosResponse {
  return {
    data,
    status,
    statusText: String(status),
    headers: {},
    config,
    request: undefined,
  };
}

describe("setupAxiosRetryCache", () => {
  it("retries regular responses when validateStatus accepts them", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, calls === 1 ? 500 : 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { retries: 1, delay: 0 },
      cache: false,
    });

    const result = await client.get("/health", {
      validateStatus: () => true,
    });

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("retries rejected responses when validateStatus rejects them", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;

      if (calls === 1) {
        const failed = response(config, 500);
        throw new AxiosError(
          "Request failed",
          undefined,
          config,
          undefined,
          failed,
        );
      }

      return response(config, 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { retries: 1, delay: 0 },
      cache: false,
    });

    const result = await client.get("/health");

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("retries network errors by default", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;

      if (calls === 1) {
        throw new AxiosError("Network Error", AxiosError.ERR_NETWORK, config);
      }

      return response(config, 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { retries: 1, delay: 0 },
      cache: false,
    });

    const result = await client.get("/health");

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not retry network errors when retryOnNetworkError is off", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      throw new AxiosError("Network Error", AxiosError.ERR_NETWORK, config);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { retries: 3, delay: 0, retryOnNetworkError: false },
      cache: false,
    });

    await expect(client.get("/health")).rejects.toThrow("Network Error");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("still retries matching status codes when retryOnNetworkError is off", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, calls === 1 ? 503 : 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { retries: 1, delay: 0, retryOnNetworkError: false },
      cache: false,
    });

    const result = await client.get("/health", { validateStatus: () => true });

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("supports per-request retry overrides", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      return response(config, 500);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { retries: 0, delay: 0 },
      cache: false,
    });

    await client.get("/slow", {
      retryCache: {
        retry: { retries: 2, delay: 0 },
      },
    });

    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("supports explicit per-request true options", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, calls === 1 ? 500 : 200, { calls });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: false,
      cache: false,
      requestKey: ({ config }) => String(config.url),
    });

    const first = await client.get("/enabled", {
      retryCache: {
        retry: true,
        cache: true,
      },
    });
    const second = await client.get("/enabled", {
      retryCache: true,
    });

    expect(first.status).toBe(200);
    expect(second.data).toEqual({ calls: 2 });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("allows globally configured options to stay disabled until enabled per request", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, calls === 2 ? 500 : 200, { calls });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { enabled: false, retries: 1, delay: 0 },
      cache: { enabled: false, ttl: 10_000 },
      requestKey: ({ config }) => String(config.url),
    });

    const first = await client.get("/configured");
    const second = await client.get("/configured", {
      retryCache: true,
    });
    const third = await client.get("/configured", {
      retryCache: true,
    });

    expect(first.data).toEqual({ calls: 1 });
    expect(second.data).toEqual({ calls: 3 });
    expect(third.data).toEqual({ calls: 3 });
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("does not cache post requests when optional methods resolve to undefined", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, 200, { calls });
    });
    const methods = undefined;
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000, methods },
      retry: false,
    });

    const first = await client.post("/submit", { name: "Ada" });
    const second = await client.post("/submit", { name: "Ada" });

    expect(first.data).toEqual({ calls: 1 });
    expect(second.data).toEqual({ calls: 2 });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("only stores responses accepted by shouldCache", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, calls < 3 ? 202 : 200, { calls });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: {
        ttl: 10_000,
        shouldCache: async ({ response }) => response.status === 200,
      },
      retry: false,
    });

    const first = await client.get("/reports");
    const second = await client.get("/reports");
    const third = await client.get("/reports");
    const fourth = await client.get("/reports");

    expect(first.data).toEqual({ calls: 1 });
    expect(second.data).toEqual({ calls: 2 });
    expect(third.data).toEqual({ calls: 3 });
    expect(fourth.data).toEqual({ calls: 3 });
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("dedupes the whole retry operation and waits for the final result", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, calls < 3 ? 503 : 200, { calls });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: { retries: 2, delay: 0 },
      requestKey: ({ config }) => String(config.url),
    });

    const [first, second] = await Promise.all([
      client.get("/users"),
      client.get("/users"),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.data).toEqual({ calls: 3 });
    expect(second.data).toEqual({ calls: 3 });
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("uses URLSearchParams when building the default request key", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, 200, { calls });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
    });

    const first = await client.get("/search", {
      params: new URLSearchParams([
        ["q", "axios"],
        ["tag", "cache"],
        ["tag", "retry"],
      ]),
    });
    const second = await client.get("/search", {
      params: new URLSearchParams([
        ["tag", "retry"],
        ["q", "axios"],
        ["tag", "cache"],
      ]),
    });
    const third = await client.get("/search", {
      params: new URLSearchParams([
        ["q", "axios"],
        ["tag", "cache"],
      ]),
    });

    expect(first.data).toEqual({ calls: 1 });
    expect(second.data).toEqual({ calls: 1 });
    expect(third.data).toEqual({ calls: 2 });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("caches by the configured requestKey and can invalidate the entry", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, 200, { calls });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => `resource:${config.url}`,
    });

    const first = await client.get("/users");
    const second = await client.get("/users");
    await client.retryCache.invalidate("resource:/users");
    const third = await client.get("/users");

    expect(first.data).toEqual({ calls: 1 });
    expect(second.data).toEqual({ calls: 1 });
    expect(third.data).toEqual({ calls: 2 });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("invalidates entries by prefix", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      return response(config, 200, { url: config.url });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => `resource:${config.url}`,
    });

    await client.get("/users");
    await client.get("/profile");

    expect(await client.retryCache.invalidatePrefix("resource:/users")).toBe(1);
    expect(await client.retryCache.get("resource:/users")).toBeUndefined();
    expect(await client.retryCache.get("resource:/profile")).toBeDefined();
  });

  it("returns stale cache only after retries are exhausted", async () => {
    let activeAdapter: AxiosAdapter = async (config) =>
      response(config, 200, { old: true });
    const client = setupAxiosRetryCache(
      axios.create({
        adapter: (config) => activeAdapter(config),
      }),
      {
        cache: { ttl: 1, staleIfError: true },
        retry: { retries: 2, delay: 0 },
        requestKey: ({ config }) => String(config.url),
      },
    );

    await client.get("/profile");
    await new Promise((resolve) => setTimeout(resolve, 2));

    const failingAdapter = vi.fn<AxiosAdapter>(async () => {
      throw new Error("network down");
    });
    activeAdapter = failingAdapter;

    const stale = await client.get("/profile");

    expect(stale.data).toEqual({ old: true });
    expect(failingAdapter).toHaveBeenCalledTimes(3);
  });
});
