import axios, { type AxiosAdapter } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage,
  type RetryCacheOptions,
  setupAxiosRetryCache,
} from "../src/index.js";

const MINUTE = 60_000;
const YEAR = 365 * 24 * 60 * MINUTE;

/** Answers 200 with the url, or fails while `failing` is set */
function network() {
  const state = { failing: false };
  const adapter = vi.fn<AxiosAdapter>(async (config) => {
    if (state.failing) {
      throw new Error("network down");
    }

    return {
      config,
      data: `fresh ${config.url}`,
      status: 200,
      statusText: "OK",
      headers: {},
    };
  });

  return { adapter, state };
}

function setup(adapter: AxiosAdapter, options: Partial<RetryCacheOptions>) {
  return setupAxiosRetryCache(axios.create({ adapter }), {
    requestKey: ({ config }) => `get:${config.url}`,
    retry: false,
    ...options,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("expired entries", () => {
  it("keeps an expired entry that a request without staleIfError read", async () => {
    const { adapter, state } = network();
    const storage = createMemoryStorage();
    const client = setup(adapter, { storage, cache: { ttl: MINUTE } });

    await client.get("/tickets/1");
    vi.setSystemTime(2 * MINUTE);
    state.failing = true;
    await expect(client.get("/tickets/1")).rejects.toThrow();

    expect(storage.get("get:/tickets/1")?.response.data).toBe(
      "fresh /tickets/1",
    );
  });

  it("keeps expired entries that are never read again, however much is written", async () => {
    const { adapter } = network();
    const storage = createMemoryStorage();
    const client = setup(adapter, { storage, cache: { ttl: MINUTE } });

    for (let index = 0; index < 100; index += 1) {
      await client.get(`/tickets/${index}`);
    }
    vi.setSystemTime(YEAR);
    await client.get("/users/1");

    expect(Array.from(storage.keys())).toHaveLength(101);
  });

  it("serves an entry written without staleIfError to a later request with staleIfError", async () => {
    const { adapter, state } = network();
    const client = setup(adapter, { cache: { ttl: MINUTE } });

    await client.get("/tickets/1");
    vi.setSystemTime(2 * MINUTE);
    state.failing = true;
    const stale = await client.get("/tickets/1", {
      retryCache: { cache: { staleIfError: true } },
    });

    expect(stale.data).toBe("fresh /tickets/1");
  });

  it("serves a stale entry however long ago it expired", async () => {
    const { adapter, state } = network();
    const client = setup(adapter, {
      cache: { ttl: MINUTE, staleIfError: true },
    });

    await client.get("/tickets/1");
    vi.setSystemTime(YEAR);
    state.failing = true;
    const stale = await client.get("/tickets/1");

    expect(stale.data).toBe("fresh /tickets/1");
  });
});
