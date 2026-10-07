import axios, {
  type AxiosAdapter,
  AxiosError,
  type AxiosResponse,
  CanceledError,
  isCancel,
} from "axios";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage,
  type RetryCacheStorage,
  setupAxiosRetryCache,
} from "../src/index.js";

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

/** Answers after `latency` ms unless the request's signal aborts first */
function abortable(status: number, latency: number): AxiosAdapter {
  return (config) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new CanceledError(undefined, config));
      };
      const timer = setTimeout(
        () => resolve(response(config, status)),
        latency,
      );

      if (config.signal?.aborted) {
        abort();
      } else {
        config.signal?.addEventListener?.("abort", abort);
      }
    });
}

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

describe("deduplication of safe methods", () => {
  it("merges concurrent OPTIONS requests", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 204);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { delay: 0 },
    });

    await Promise.all([client.options("/users"), client.options("/users")]);

    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe("deduplication of writes", () => {
  it("sends concurrent identical writes separately", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 201);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }));

    await Promise.all([
      client.post("/orders", { sku: "A" }),
      client.post("/orders", { sku: "A" }),
    ]);

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("sends every write even when the key ignores the body", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 201);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      requestKey: ({ config }) => `${config.method} ${config.url}`,
    });

    await Promise.all([
      client.post("/messages", { text: "first" }),
      client.post("/messages", { text: "second" }),
    ]);

    expect(adapter.mock.calls.map(([config]) => config.data)).toEqual([
      JSON.stringify({ text: "first" }),
      JSON.stringify({ text: "second" }),
    ]);
  });

  it("still merges requests of a method the cache is enabled for", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000, methods: ["get", "post"] },
      retry: false,
    });

    await Promise.all([
      client.post("/search", { query: "ada" }),
      client.post("/search", { query: "ada" }),
    ]);

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("keeps cached POSTs with different bodies apart under the default key", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 200, config.data);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000, methods: ["get", "post"] },
      retry: false,
    });

    const [ada, bob] = await Promise.all([
      client.post("/search", { query: "ada" }),
      client.post("/search", { query: "bob" }),
    ]);
    const bobAgain = await client.post("/search", { query: "bob" });

    expect([ada.data, bob.data, bobAgain.data]).toEqual([
      { query: "ada" },
      { query: "bob" },
      { query: "bob" },
    ]);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("treats cached POSTs under one key as one request, whatever their body", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(config, 200, config.data);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000, methods: ["get", "post"] },
      retry: false,
      requestKey: ({ config }) => `${config.method} ${config.url}`,
    });

    const [ada, bob] = await Promise.all([
      client.post("/search", { query: "ada" }),
      client.post("/search", { query: "bob" }),
    ]);
    const carol = await client.post("/search", { query: "carol" });

    expect([ada.data, bob.data, carol.data]).toEqual([
      { query: "ada" },
      { query: "ada" },
      { query: "ada" },
    ]);
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe("merged callers", () => {
  it("hands every merged caller its own config", async () => {
    const adapter = vi.fn<AxiosAdapter>(abortable(200, 5));
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    const [first, second] = await Promise.all([
      client.get("/users", { headers: { "x-caller": "first" } }),
      client.get("/users", { headers: { "x-caller": "second" } }),
    ]);

    expect(first.config.headers["x-caller"]).toBe("first");
    expect(second.config.headers["x-caller"]).toBe("second");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("rejects every merged caller with its own copy of the error", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new AxiosError("Network Error", "ERR_NETWORK", config);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    const fail = (caller: string) =>
      client
        .get("/users", { headers: { "x-caller": caller } })
        .catch((error: unknown) => error as AxiosError);
    const [firstError, secondError] = await Promise.all([
      fail("first"),
      fail("second"),
    ]);

    expect(firstError).toBeInstanceOf(AxiosError);
    expect(secondError).toBeInstanceOf(AxiosError);
    expect(secondError).not.toBe(firstError);
    expect(secondError?.message).toBe("Network Error");
    expect(firstError?.config?.headers["x-caller"]).toBe("first");
    expect(secondError?.config?.headers["x-caller"]).toBe("second");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("keeps a canceled merged request a cancel for every caller", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new CanceledError(undefined, config);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    const fail = (caller: string) =>
      client
        .get("/users", { headers: { "x-caller": caller } })
        .catch((error: unknown) => error as AxiosError);
    const [firstError, secondError] = await Promise.all([
      fail("first"),
      fail("second"),
    ]);

    expect(isCancel(firstError)).toBe(true);
    expect(isCancel(secondError)).toBe(true);
    expect(secondError?.config?.headers["x-caller"]).toBe("second");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("rejects a merged caller's abort with its own config", async () => {
    const adapter = vi.fn<AxiosAdapter>(abortable(200, 50));
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });
    const controller = new AbortController();

    const aborted = client
      .get("/users", {
        headers: { "x-caller": "first" },
        signal: controller.signal,
      })
      .catch((error: unknown) => error as AxiosError);
    const other = client.get("/users");
    setTimeout(() => controller.abort(), 10);
    const [error] = await Promise.all([aborted, other]);

    expect(error).toBeInstanceOf(CanceledError);
    expect(error.config?.headers["x-caller"]).toBe("first");
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe("cache lifecycle", () => {
  it("does not cache a 404 that validateStatus accepts", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 404),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    await client.get("/users/1", accepted);
    const second = await client.get("/users/1", accepted);

    expect(second.status).toBe(404);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it.each([301, 302, 304, 500])(
    "does not cache a %i that validateStatus accepts",
    async (status) => {
      const adapter = vi.fn<AxiosAdapter>(async (config) =>
        response(config, status),
      );
      const client = setupAxiosRetryCache(axios.create({ adapter }), {
        cache: { ttl: 10_000 },
        retry: false,
        requestKey: ({ config }) => String(config.url),
      });

      await client.get("/users/1", accepted);
      const second = await client.get("/users/1", accepted);

      expect(second.status).toBe(status);
      expect(adapter).toHaveBeenCalledTimes(2);
    },
  );

  it("stores a 404 when a custom shouldCache accepts it", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 404),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: {
        ttl: 10_000,
        shouldCache: ({ response }) => response.status === 404,
      },
      retry: false,
      requestKey: ({ config }) => String(config.url),
    });

    await client.get("/users/1", accepted);
    const second = await client.get("/users/1", accepted);

    expect(second.status).toBe(404);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

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

  it("answers a request whose response cannot be stored", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const storage: RetryCacheStorage = {
      get: () => undefined,
      set: () => {
        throw new Error("storage full");
      },
      delete: () => false,
      clear: () => undefined,
    };
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: { retries: 2, delay: 0 },
      requestKey: ({ config }) => String(config.url),
      storage,
    });

    const result = await client.get("/users");

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("fetches a request whose cache entry cannot be read", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const storage: RetryCacheStorage = {
      get: () => {
        throw new Error("storage down");
      },
      set: () => undefined,
      delete: () => false,
      clear: () => undefined,
    };
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: { retries: 2, delay: 0 },
      requestKey: ({ config }) => String(config.url),
      storage,
    });

    const result = await client.get("/users");

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("answers a request when an async storage rejects", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const storage: RetryCacheStorage = {
      get: () => Promise.reject(new Error("storage down")),
      set: () => Promise.reject(new Error("storage full")),
      delete: () => Promise.resolve(false),
      clear: () => Promise.resolve(),
    };
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: { retries: 2, delay: 0 },
      requestKey: ({ config }) => String(config.url),
      storage,
    });

    const result = await client.get("/users");

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(1);
    await expect(client.retryCache.get("/users")).rejects.toThrow(
      "storage down",
    );
  });

  it("does not retry a request whose shouldCache throws", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: {
        ttl: 10_000,
        shouldCache: () => {
          throw new Error("predicate failed");
        },
      },
      retry: { retries: 2, delay: 0 },
      requestKey: ({ config }) => String(config.url),
    });

    await expect(client.get("/users")).rejects.toThrow("predicate failed");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("reads the cache entry once per request", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const memory = createMemoryStorage();
    const get = vi.fn((key: string) => memory.get(key));
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: { delay: 0 },
      requestKey: ({ config }) => String(config.url),
      storage: {
        get,
        set: (key, entry) => memory.set(key, entry),
        delete: (key) => memory.delete(key),
        clear: () => memory.clear(),
      },
    });

    await client.get("/users");

    expect(get).toHaveBeenCalledTimes(1);
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

  it("returns the response at once when Retry-After asks for more than maxDelay", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 503, undefined, { "retry-after": "1" }),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 1, delay: 0, maxDelay: 50 },
    });

    const answer = await client.get("/status", accepted);

    expect(answer.status).toBe(503);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("rejects at once when a thrown 503 carries a Retry-After above maxDelay", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      throw new AxiosError(
        "Service Unavailable",
        AxiosError.ERR_BAD_RESPONSE,
        config,
        undefined,
        response(config, 503, undefined, { "retry-after": "1" }),
      );
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 1, delay: 0, maxDelay: 50 },
    });

    await expect(client.get("/status")).rejects.toMatchObject({
      message: "Service Unavailable",
      response: { status: 503 },
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, -1, "30000"])(
    "refuses maxDelay: %s at setup",
    (maxDelay) => {
      expect(() =>
        setupAxiosRetryCache(axios.create(), {
          retry: { maxDelay: maxDelay as number },
        }),
      ).toThrow(TypeError);
    },
  );

  it("rejects a request with an invalid maxDelay without sending it", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
    });

    await expect(
      client.get("/status", {
        retryCache: { retry: { maxDelay: Number.NaN } },
      }),
    ).rejects.toThrow(TypeError);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("accepts maxDelay: 0 and Infinity", () => {
    expect(() =>
      setupAxiosRetryCache(axios.create(), { retry: { maxDelay: 0 } }),
    ).not.toThrow();
    expect(() =>
      setupAxiosRetryCache(axios.create(), { retry: { maxDelay: Infinity } }),
    ).not.toThrow();
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

describe("aborting", () => {
  it("does not retry a request whose signal was aborted", async () => {
    const adapter = vi.fn<AxiosAdapter>(abortable(200, 50));
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 2, delay: 0 },
    });
    const controller = new AbortController();

    const request = client.get("/users", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(request).rejects.toMatchObject({ code: "ERR_CANCELED" });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for the retry delay on abort", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 503),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 1, delay: 50 },
    });
    const controller = new AbortController();

    const request = client.get("/users", {
      ...accepted,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    await expect(request).rejects.toMatchObject({ code: "ERR_CANCELED" });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("rejects an abort during the retry delay with the request's config", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 503),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      dedupe: false,
      retry: { retries: 1, delay: 50 },
    });
    const controller = new AbortController();

    const request = client
      .get("/users", { ...accepted, signal: controller.signal })
      .catch((caught: unknown) => caught as AxiosError);
    setTimeout(() => controller.abort(), 10);
    const error = await request;

    expect(error).toBeInstanceOf(CanceledError);
    expect(error.config?.url).toBe("/users");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("rejects at the retry delay with the request's config once an attempt saw the abort", async () => {
    const controller = new AbortController();
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      controller.abort();
      return response(config, 503);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      dedupe: false,
      retry: { retries: 1, delay: 50 },
    });

    const error = await client
      .get("/users", { ...accepted, signal: controller.signal })
      .catch((caught: unknown) => caught as AxiosError);

    expect(error).toBeInstanceOf(CanceledError);
    expect(error.config?.url).toBe("/users");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("starts no shared request for a caller aborted before dedupe runs", async () => {
    const adapter = vi.fn<AxiosAdapter>(abortable(200, 5));
    const memory = createMemoryStorage();
    const get = vi.fn((key: string) => memory.get(key));
    const controller = new AbortController();
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
      retry: false,
      requestKey: ({ config }) => {
        controller.abort();
        return String(config.url);
      },
      storage: {
        get,
        set: (key, entry) => memory.set(key, entry),
        delete: (key) => memory.delete(key),
        clear: () => memory.clear(),
      },
    });

    await expect(
      client.get("/users", { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "ERR_CANCELED",
      config: { url: "/users" },
    });

    expect(get).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });

  it("keeps a merged request running for the callers that did not abort", async () => {
    const adapter = vi.fn<AxiosAdapter>(abortable(200, 50));
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 0 },
      requestKey: ({ config }) => String(config.url),
    });
    const controller = new AbortController();

    const requests = Promise.allSettled([
      client.get("/users", { signal: controller.signal }),
      client.get("/users"),
    ]);
    setTimeout(() => controller.abort(), 10);
    const [aborted, other] = await requests;

    expect(aborted).toMatchObject({
      status: "rejected",
      reason: { code: "ERR_CANCELED" },
    });
    expect(other).toMatchObject({
      status: "fulfilled",
      value: { status: 200 },
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("aborts the merged request once every caller has aborted", async () => {
    const adapter = vi.fn<AxiosAdapter>(abortable(200, 50));
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      retry: { retries: 0 },
      requestKey: ({ config }) => String(config.url),
    });
    const first = new AbortController();
    const second = new AbortController();

    const requests = Promise.allSettled([
      client.get("/users", { signal: first.signal }),
      client.get("/users", { signal: second.signal }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sharedSignal = adapter.mock.calls[0]?.[0].signal;

    first.abort();
    expect(sharedSignal?.aborted).toBe(false);

    second.abort();
    expect(sharedSignal?.aborted).toBe(true);

    await requests;
    await client.get("/users");
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});
