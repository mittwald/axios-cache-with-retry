import axios, { type AxiosAdapter } from "axios";
import { describe, expect, it } from "vitest";
import {
  createMemoryStorage,
  type RetryCacheOptions,
  setupAxiosRetryCache,
} from "../src/index.js";

/** An adapter whose requests stay in flight until the test answers them */
function pending() {
  const answers: ((data: string) => void)[] = [];
  const adapter: AxiosAdapter = (config) =>
    new Promise((resolve) => {
      answers.push((data) =>
        resolve({ config, data, status: 200, statusText: "OK", headers: {} }),
      );
    });

  return {
    adapter,
    answer: (index: number, data: string) => answers[index]?.(data),
    get calls() {
      return answers.length;
    },
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
  it("lets a caller after invalidate join the request started before it", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    const second = client.get("/tickets/1");
    await tick();
    network.answer(0, "old");

    expect((await first).data).toBe("old");
    expect((await second).data).toBe("old");
    expect(network.calls).toBe(1);
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
    expect(network.calls).toBe(1);
  });

  it("stores the response of a request that was in flight during invalidate", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    network.answer(0, "old");
    await first;

    const entry = await client.retryCache.get("get:/tickets/1");
    expect(entry?.response.data).toBe("old");
  });

  it("stores the response of a request that was in flight during invalidatePrefix", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidatePrefix("get:/tickets/");
    network.answer(0, "old");
    await first;

    const entry = await client.retryCache.get("get:/tickets/1");
    expect(entry?.response.data).toBe("old");
  });

  it("stores the response of a request that was in flight during clear", async () => {
    const network = pending();
    const client = setup(network.adapter);

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.clear();
    network.answer(0, "old");
    await first;

    const entry = await client.retryCache.get("get:/tickets/1");
    expect(entry?.response.data).toBe("old");
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
    expect(network.calls).toBe(1);
  });

  it("stores the response of another instance's request after invalidating through one instance on the same storage", async () => {
    const storage = createMemoryStorage();
    const network = pending();
    const internal = setup(network.adapter, { storage });
    const external = setup(network.adapter, { storage });

    const first = external.get("/tickets/1");
    await tick();
    await internal.retryCache.invalidate("get:/tickets/1");
    network.answer(0, "old");
    await first;

    const entry = await storage.get("get:/tickets/1");
    expect(entry?.response.data).toBe("old");
  });

  it("lets a caller after invalidate join a request that is deduplicated but not cached", async () => {
    const network = pending();
    const client = setup(network.adapter, { cache: false, retry: {} });

    const first = client.get("/tickets/1");
    await tick();
    await client.retryCache.invalidate("get:/tickets/1");
    const second = client.get("/tickets/1");
    await tick();
    network.answer(0, "old");
    await Promise.all([first, second]);

    expect(network.calls).toBe(1);
  });
});
