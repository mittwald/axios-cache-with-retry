import axios, { type AxiosAdapter } from "axios";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage,
  type InvalidationTarget,
  type RetryCacheOptions,
  type RetryCacheStorage,
  setupAxiosRetryCache,
} from "../src/index.js";

/** An adapter whose requests stay in flight until the test answers them */
function pending() {
  const answers: ((data: string) => void)[] = [];
  const adapter = vi.fn<AxiosAdapter>(
    (config) =>
      new Promise((resolve) => {
        answers.push((data) =>
          resolve({ config, data, status: 200, statusText: "OK", headers: {} }),
        );
      }),
  );

  return {
    adapter,
    answer: (index: number, data: string) => answers[index]?.(data),
  };
}

function setup(
  adapter: AxiosAdapter,
  options: Partial<RetryCacheOptions> = {},
) {
  return setupAxiosRetryCache(axios.create({ adapter }), {
    requestKey: ({ config }) => `get:${config.url}`,
    cache: { ttl: 60_000 },
    retry: false,
    ...options,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("invalidation while a request is in flight", () => {
  it("starts a new request for a caller after invalidate", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    const second = client.get("/tickets/1");
    await tick();
    network.answer(1, "new");
    network.answer(0, "old");

    expect((await first).data).toBe("old");
    expect((await second).data).toBe("new");
    expect(network.adapter).toHaveBeenCalledTimes(2);
    const entry = await client.retryCache.get("get:/tickets/1");
    expect(entry?.response.data).toBe("new");
  });

  it("still answers callers that joined before invalidate", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    const joined = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    network.answer(0, "old");

    expect((await first).data).toBe("old");
    expect((await joined).data).toBe("old");
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("does not store the response of a request that was in flight during invalidate", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    network.answer(0, "old");
    await first;

    expect(await client.retryCache.get("get:/tickets/1")).toBeUndefined();
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("does not store the response of a request that was in flight during invalidatePrefix", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidatePrefix("get:/tickets/");
    network.answer(0, "old");
    await first;

    expect(await client.retryCache.get("get:/tickets/1")).toBeUndefined();
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("does not store the response of a request that was in flight during clear", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.clear();
    network.answer(0, "old");
    await first;

    expect(await client.retryCache.get("get:/tickets/1")).toBeUndefined();
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("does not store a response when invalidate runs while shouldCache decides", async () => {
    const network = pending();
    let decide: (store: boolean) => void = () => undefined;
    const client = setup(network.adapter, {
      cache: {
        ttl: 60_000,
        shouldCache: () =>
          new Promise<boolean>((resolve) => (decide = resolve)),
      },
    });

    const first = client.get("/tickets/1");
    await tick();
    network.answer(0, "old");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    decide(true);
    await first;

    expect(await client.retryCache.get("get:/tickets/1")).toBeUndefined();
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("leaves requests whose key does not match alone", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/2");
    await tick();
    await client.retryCache.invalidatePrefix("get:/tickets/1");
    const second = client.get("/tickets/2");
    await tick();
    network.answer(0, "kept");
    await Promise.all([first, second]);

    const entry = await client.retryCache.get("get:/tickets/2");
    expect(entry?.response.data).toBe("kept");
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("does not store the response of another instance's request after invalidating through one instance on the same storage", async () => {
    const storage = createMemoryStorage();
    const network = pending();
    const internal = setup(network.adapter, { storage });
    const external = setup(network.adapter, { storage });

    const first = external.get("/tickets/1");
    await tick();
    await internal.retryCache.invalidate("get:/tickets/1");
    network.answer(0, "old");
    await first;

    expect(await storage.get("get:/tickets/1")).toBeUndefined();
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("starts a new request on the other instance after invalidating through one instance on the same storage", async () => {
    const storage = createMemoryStorage();
    const network = pending();
    const internal = setup(network.adapter, { storage });
    const external = setup(network.adapter, { storage });

    const first = external.get("/tickets/1");
    await tick();
    await internal.retryCache.invalidate("get:/tickets/1");
    const second = external.get("/tickets/1");
    await tick();
    network.answer(1, "new");
    network.answer(0, "old");

    expect((await first).data).toBe("old");
    expect((await second).data).toBe("new");
    expect(network.adapter).toHaveBeenCalledTimes(2);
  });

  it("starts a new request after invalidate when requests are deduplicated but not cached", async () => {
    const network = pending();
    const client = setup(network.adapter, {
      cache: false,
      retry: { delay: 0 },
    });

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    const second = client.get("/tickets/1");
    await tick();
    network.answer(0, "old");
    network.answer(1, "new");

    expect((await second).data).toBe("new");
    await first;
    expect(network.adapter).toHaveBeenCalledTimes(2);
  });
});

describe("a detached request that fails", () => {
  it("does not serve the entry from before invalidate, even with staleIfError", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let fail: (error: Error) => void = () => undefined;
    const adapter = vi
      .fn<AxiosAdapter>()
      .mockImplementationOnce(async (config) => ({
        config,
        data: "before",
        status: 200,
        statusText: "OK",
        headers: {},
      }))
      .mockImplementationOnce(
        () => new Promise((_, reject) => (fail = reject)),
      );
    const client = setup(adapter, {
      cache: { ttl: 1_000, staleIfError: true },
    });

    try {
      await client.get("/tickets/1");
      vi.setSystemTime(Date.now() + 2_000);
      const waiting = client.get("/tickets/1");
      await tick();
      await client.retryCache.invalidate("get:/tickets/1");
      fail(new Error("network down"));

      await expect(waiting).rejects.toThrow("network down");
      expect(adapter).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stored entries", () => {
  it("keep the key, the timestamps, the response and the request", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1", { baseURL: "https://api.test" });
    await tick();
    network.answer(0, "ticket");
    await first;

    const entry = await client.retryCache.get("get:/tickets/1");
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "key",
      "request",
      "response",
      "staleUntil",
    ]);
    expect(entry?.request).toEqual({
      method: "get",
      url: "/tickets/1",
      baseURL: "https://api.test",
    });
  });
});

describe("invalidateWhere", () => {
  const tickets = ({ url }: InvalidationTarget) =>
    url?.startsWith("/tickets/") ?? false;

  it("deletes the stored entries the predicate matches and counts them", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const requests = [
      client.get("/tickets/1"),
      client.get("/tickets/2"),
      client.get("/users/1"),
    ];
    await tick();
    network.answer(0, "ticket 1");
    network.answer(1, "ticket 2");
    network.answer(2, "user 1");
    await Promise.all(requests);

    expect(await client.retryCache.invalidateWhere(tickets)).toBe(2);
    expect(network.adapter).toHaveBeenCalledTimes(3);
    expect(await client.retryCache.get("get:/tickets/1")).toBeUndefined();
    expect(await client.retryCache.get("get:/tickets/2")).toBeUndefined();
    expect((await client.retryCache.get("get:/users/1"))?.response.data).toBe(
      "user 1",
    );
  });

  it("hands the predicate the key, the lowercased method, the url and the base url", async () => {
    const network = pending();
    const client = setup(network.adapter);
    const seen: InvalidationTarget[] = [];

    const first = client.request({
      method: "GET",
      url: "/tickets/1",
      baseURL: "https://api.test",
    });
    await tick();
    network.answer(0, "ticket");
    await first;
    await client.retryCache.invalidateWhere((target) => {
      seen.push(target);
      return false;
    });

    expect(seen).toEqual([
      {
        key: "get:/tickets/1",
        method: "get",
        url: "/tickets/1",
        baseURL: "https://api.test",
      },
    ]);
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("detaches the matching requests in flight", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidateWhere(tickets);
    const second = client.get("/tickets/1");
    await tick();
    network.answer(0, "old");
    network.answer(1, "new");

    expect((await first).data).toBe("old");
    expect((await second).data).toBe("new");
    expect(network.adapter).toHaveBeenCalledTimes(2);
    expect((await client.retryCache.get("get:/tickets/1"))?.response.data).toBe(
      "new",
    );
  });

  it("leaves requests in flight alone that the predicate does not match", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/users/1");
    await tick();
    await client.retryCache.invalidateWhere(tickets);
    const second = client.get("/users/1");
    await tick();
    network.answer(0, "user");
    await Promise.all([first, second]);

    expect(network.adapter).toHaveBeenCalledTimes(1);
    expect((await client.retryCache.get("get:/users/1"))?.response.data).toBe(
      "user",
    );
  });

  it("hands only the key for an entry stored without its request", async () => {
    const storage = createMemoryStorage();
    const network = pending();
    const client = setup(network.adapter, { storage });
    storage.set("get:/tickets/1", {
      key: "get:/tickets/1",
      createdAt: 0,
      expiresAt: Date.now() + 60_000,
      response: { data: "", status: 200, statusText: "OK", headers: {} },
    });
    const seen: InvalidationTarget[] = [];

    await client.retryCache.invalidateWhere((target) => {
      seen.push(target);
      return true;
    });

    expect(seen).toEqual([{ key: "get:/tickets/1" }]);
    expect(network.adapter).not.toHaveBeenCalled();
    expect(storage.get("get:/tickets/1")).toBeUndefined();
  });

  it("records the request of a response stored through retryCache.set", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1", { retryCache: false });
    await tick();
    network.answer(0, "ticket");
    await client.retryCache.set("custom", await first);

    expect(await client.retryCache.invalidateWhere(tickets)).toBe(1);
    expect(network.adapter).toHaveBeenCalledTimes(1);
  });

  it("rejects for a storage that cannot list its keys", async () => {
    const storage: RetryCacheStorage = {
      get: () => undefined,
      set: () => undefined,
      delete: () => false,
      clear: () => undefined,
    };
    const client = setup(pending().adapter, { storage });

    await expect(client.retryCache.invalidateWhere(() => true)).rejects.toThrow(
      "Storage backend does not support predicate invalidation.",
    );
  });
});
