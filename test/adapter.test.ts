import axios, { type AxiosAdapter, type AxiosResponse } from "axios";
import { describe, expect, it, vi } from "vitest";
import { setupAxiosRetryCache } from "../src/index.js";

function response(
  config: AxiosResponse["config"],
  status: number,
  data: unknown = { ok: status < 400 },
  headers: Record<string, string> = {},
): AxiosResponse {
  return {
    data,
    status,
    statusText: String(status),
    headers,
    config,
    request: undefined,
  };
}

const accepted = { validateStatus: () => true };

describe("adapter installation", () => {
  it("does not stack retry loops when setup runs twice on one instance", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 500),
    );
    const options = { retry: { retries: 1, delay: 0 }, cache: false } as const;
    const once = setupAxiosRetryCache(axios.create({ adapter }), options);
    const twice = setupAxiosRetryCache(once, options);

    await twice.get("/health", accepted);

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("exposes the cache api on the very same instance", () => {
    const instance = axios.create();
    const client = setupAxiosRetryCache(instance);

    expect(client).toBe(instance);
    expect(typeof client.retryCache.invalidatePrefix).toBe("function");
  });

  it("resolves a named default adapter instead of calling the string", async () => {
    const client = setupAxiosRetryCache(axios.create({ adapter: "http" }), {
      cache: { ttl: 10_000 },
      retry: false,
    });

    await expect(
      client.get("http://127.0.0.1:1/never", { timeout: 50 }),
    ).rejects.toThrow();
  });
});

describe("opting out", () => {
  it("bypasses the adapter entirely for retryCache: false", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200, { url: config.url }),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    await client.get("/users", { retryCache: false });
    await client.get("/users", { retryCache: false });

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(await client.retryCache.get("/users")).toBeUndefined();
  });

  it("lets a single request opt out of deduplication", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 0 },
      requestKey: ({ config }) => String(config.url),
    });

    await Promise.all([
      client.get("/users", { retryCache: { dedupe: false } }),
      client.get("/users", { retryCache: { dedupe: false } }),
    ]);

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not deduplicate when neither cache nor retry is enabled", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: false,
      dedupe: true,
      requestKey: ({ config }) => String(config.url),
    });

    await Promise.all([client.get("/users"), client.get("/users")]);

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("excludes a request from cache and dedupe when its key is undefined", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: () => undefined,
    });

    await Promise.all([client.get("/users"), client.get("/users")]);
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("does not retry methods outside the retry allow list", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 503),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 3, delay: 0 },
    });

    await client.post("/submit", { name: "Ada" }, accepted);

    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe("cache lifecycle", () => {
  it("short-circuits retry on a cache hit", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200, { fresh: true }),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: { retries: 2, delay: 0 },
      requestKey: ({ config }) => String(config.url),
    });

    await client.get("/users");
    const hit = await client.get("/users");

    expect(hit.data).toEqual({ fresh: true });
    expect(hit.request).toBeUndefined();
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("refetches once the ttl has passed", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, 200, { calls });
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 1 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    await client.get("/users");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await client.get("/users");

    expect(second.data).toEqual({ calls: 2 });
  });

  it("caches responses but never failures", async () => {
    const adapter = vi.fn<AxiosAdapter>(async () => {
      throw new Error("network down");
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: { retries: 1, delay: 0 },
      requestKey: ({ config }) => String(config.url),
    });

    await expect(client.get("/users")).rejects.toThrow("network down");

    expect(await client.retryCache.get("/users")).toBeUndefined();
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("serves a manually seeded entry and honours a ttl override", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200, { from: "network" }),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });
    const seeded = response(
      { headers: {} } as AxiosResponse["config"],
      200,
      { from: "cache" },
      { ETag: 'W/"1"' },
    );

    await client.retryCache.set("/users", seeded);
    const hit = await client.get("/users");

    expect(hit.data).toEqual({ from: "cache" });
    expect(hit.headers.etag).toBe('W/"1"');
    expect(adapter).not.toHaveBeenCalled();

    await client.retryCache.set("/profile", seeded, { ttl: -1 });
    await client.get("/profile");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("normalizes header names and values on the way into the cache", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => ({
      ...response(config, 200),
      headers: { "Set-Cookie": ["a=1", "b=2"], "X-Total": 7 },
      request: { id: 1 },
    }));
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    const live = await client.get("/users");
    const hit = await client.get("/users");

    expect(live.headers.get("set-cookie")).toEqual(["a=1", "b=2"]);
    expect(live.request).toEqual({ id: 1 });

    expect(hit.headers.get("set-cookie")).toBe("a=1, b=2");
    expect(hit.headers["x-total"]).toBe("7");
    expect(hit.request).toBeUndefined();
  });

  it("clears every entry at once", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    await client.get("/users");
    await client.get("/profile");
    await client.retryCache.clear();
    await client.get("/users");
    await client.get("/profile");

    expect(adapter).toHaveBeenCalledTimes(4);
  });

  it("reports whether an invalidation removed anything", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    await client.get("/users");

    expect(await client.retryCache.invalidate("/users")).toBe(true);
    expect(await client.retryCache.invalidate("/users")).toBe(false);
  });
});

describe("retry timing", () => {
  it("lets a Retry-After header override a configured delay", async () => {
    const delay = vi.fn(() => 5_000);
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;

      return calls === 1
        ? response(config, 429, { ok: false }, { "retry-after": "0" })
        : response(config, 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 1, delay },
    });

    const result = await client.get("/health", accepted);

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(delay).not.toHaveBeenCalled();
  });

  it("waits between attempts when a fixed delay is configured", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, calls === 1 ? 503 : 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 1, delay: 20 },
    });
    const started = Date.now();

    await client.get("/health", accepted);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
