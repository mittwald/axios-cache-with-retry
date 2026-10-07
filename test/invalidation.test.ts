import axios, { type AxiosAdapter } from "axios";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage,
  type RetryCacheOptions,
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
  it("serves the entry from before invalidate with staleIfError", async () => {
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

      expect((await waiting).data).toBe("before");
      expect(adapter).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
