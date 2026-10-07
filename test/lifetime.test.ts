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
  it("deletes an expired entry that a request without staleIfError read", async () => {
    const { adapter, state } = network();
    const storage = createMemoryStorage();
    const client = setup(adapter, { storage, cache: { ttl: MINUTE } });

    await client.get("/tickets/1");
    vi.setSystemTime(2 * MINUTE);
    state.failing = true;
    await expect(client.get("/tickets/1")).rejects.toThrow();

    expect(storage.get("get:/tickets/1")).toBeUndefined();
  });

  it("sweeps expired entries that are never read again on a later write", async () => {
    const { adapter } = network();
    const storage = createMemoryStorage();
    const client = setup(adapter, { storage, cache: { ttl: MINUTE } });

    for (let index = 0; index < 100; index += 1) {
      await client.get(`/tickets/${index}`);
    }
    vi.setSystemTime(YEAR);
    await client.get("/users/1");

    expect(Array.from(storage.keys())).toEqual(["get:/users/1"]);
  });

  it("does not serve an entry written without staleIfError to a later request with staleIfError", async () => {
    const { adapter, state } = network();
    const client = setup(adapter, { cache: { ttl: MINUTE } });

    await client.get("/tickets/1");
    vi.setSystemTime(2 * MINUTE);
    state.failing = true;
    await expect(
      client.get("/tickets/1", {
        retryCache: { cache: { staleIfError: true } },
      }),
    ).rejects.toThrow("network down");
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

  it("serves a stale entry until maxStaleAge has passed, then deletes it", async () => {
    const { adapter, state } = network();
    const storage = createMemoryStorage();
    const client = setup(adapter, {
      storage,
      cache: { ttl: MINUTE, staleIfError: true, maxStaleAge: 10 * MINUTE },
    });

    await client.get("/tickets/1");
    state.failing = true;
    vi.setSystemTime(11 * MINUTE - 1);
    expect((await client.get("/tickets/1")).data).toBe("fresh /tickets/1");

    vi.setSystemTime(11 * MINUTE);
    await expect(client.get("/tickets/1")).rejects.toThrow("network down");
    expect(storage.get("get:/tickets/1")).toBeUndefined();
  });

  it("does not serve an entry whose maxStaleAge passes while the request runs", async () => {
    const { adapter, state } = network();
    const client = setup(adapter, {
      cache: { ttl: MINUTE, staleIfError: true, maxStaleAge: 10 * MINUTE },
    });

    await client.get("/tickets/1");
    vi.setSystemTime(11 * MINUTE - 1);
    state.failing = true;
    adapter.mockImplementationOnce(async () => {
      vi.setSystemTime(11 * MINUTE);
      throw new Error("network down");
    });

    await expect(client.get("/tickets/1")).rejects.toThrow("network down");
  });

  it("records until when an entry may be served", async () => {
    const { adapter } = network();
    const storage = createMemoryStorage();
    const client = setup(adapter, { storage, cache: { ttl: MINUTE } });

    await client.get("/fresh");
    await client.get("/stale", {
      retryCache: { cache: { staleIfError: true } },
    });
    await client.get("/bounded", {
      retryCache: { cache: { staleIfError: true, maxStaleAge: MINUTE } },
    });

    expect(storage.get("get:/fresh")?.staleUntil).toBe(MINUTE);
    expect(storage.get("get:/stale")).not.toHaveProperty("staleUntil");
    expect(storage.get("get:/bounded")?.staleUntil).toBe(2 * MINUTE);
  });

  it("gives an entry stored through retryCache.set the lifetime of the global options", async () => {
    const { adapter } = network();
    const storage = createMemoryStorage();
    const client = setup(adapter, {
      storage,
      cache: { ttl: MINUTE, staleIfError: true, maxStaleAge: MINUTE },
    });

    await client.retryCache.set("custom", await client.get("/tickets/1"), {
      ttl: 2 * MINUTE,
    });

    expect(storage.get("custom")).toMatchObject({
      expiresAt: 2 * MINUTE,
      staleUntil: 3 * MINUTE,
    });
  });

  it("answers a request when deleting an expired entry fails", async () => {
    const { adapter } = network();
    const storage = createMemoryStorage();
    storage.delete = () => {
      throw new Error("storage down");
    };
    const client = setup(adapter, { storage, cache: { ttl: MINUTE } });

    await client.get("/tickets/1");
    vi.setSystemTime(2 * MINUTE);

    expect((await client.get("/tickets/1")).data).toBe("fresh /tickets/1");
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});

describe("sweeping the memory storage", () => {
  function entry(key: string, staleUntil?: number) {
    return {
      key,
      createdAt: 0,
      expiresAt: 0,
      ...(staleUntil === undefined ? {} : { staleUntil }),
      response: { data: key, status: 200, statusText: "OK", headers: {} },
    };
  }

  it("removes dead entries on the first write after sweepInterval", () => {
    const storage = createMemoryStorage({ sweepInterval: MINUTE });

    storage.set("dead", entry("dead", 1));
    storage.set("unlimited", entry("unlimited"));
    storage.set("alive", entry("alive", 10 * MINUTE));
    vi.setSystemTime(MINUTE - 1);
    storage.set("early", entry("early", 10 * MINUTE));
    expect(Array.from(storage.keys())).toContain("dead");

    vi.setSystemTime(MINUTE);
    storage.set("late", entry("late", 10 * MINUTE));

    expect(Array.from(storage.keys())).toEqual([
      "unlimited",
      "alive",
      "early",
      "late",
    ]);
  });

  it("sweeps every five minutes by default", () => {
    const storage = createMemoryStorage();

    storage.set("dead", entry("dead", 1));
    vi.setSystemTime(5 * MINUTE - 1);
    storage.set("a", entry("a"));
    expect(Array.from(storage.keys())).toContain("dead");

    vi.setSystemTime(5 * MINUTE);
    storage.set("b", entry("b"));
    expect(Array.from(storage.keys())).not.toContain("dead");
  });
});
