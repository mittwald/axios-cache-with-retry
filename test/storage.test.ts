import { describe, expect, it } from "vitest";
import {
  createMemoryStorage,
  deletePrefix,
  MemoryRetryCacheStorage,
} from "../src/storage.js";
import type { CacheEntry, RetryCacheStorage } from "../src/types.js";

function entry(key: string): CacheEntry {
  return {
    key,
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
    response: { data: key, status: 200, statusText: "200", headers: {} },
  };
}

describe("MemoryRetryCacheStorage", () => {
  it("round-trips, deletes and clears entries", () => {
    const storage = new MemoryRetryCacheStorage();

    storage.set("a", entry("a"));

    expect(storage.get("a")?.response.data).toBe("a");
    expect(storage.get("missing")).toBeUndefined();
    expect(storage.delete("a")).toBe(true);
    expect(storage.delete("a")).toBe(false);

    storage.set("b", entry("b"));
    storage.clear();

    expect(Array.from(storage.keys())).toEqual([]);
  });

  it("keeps expired entries, because staleIfError still needs them", () => {
    const storage = createMemoryStorage();
    const expired: CacheEntry = { ...entry("a"), expiresAt: Date.now() - 1 };

    storage.set("a", expired);

    expect(storage.get("a")).toBe(expired);
  });

  it("drops the oldest insertion once maxEntries is exceeded", () => {
    const storage = createMemoryStorage({ maxEntries: 2 });

    storage.set("a", entry("a"));
    storage.set("b", entry("b"));
    storage.set("c", entry("c"));

    expect(Array.from(storage.keys())).toEqual(["b", "c"]);
  });

  it("is not an LRU: re-setting a key does not make it younger", () => {
    const storage = createMemoryStorage({ maxEntries: 2 });

    storage.set("a", entry("a"));
    storage.set("b", entry("b"));
    storage.set("a", entry("a"));
    storage.set("c", entry("c"));

    expect(Array.from(storage.keys())).toEqual(["b", "c"]);
  });

  it("is unbounded without maxEntries", () => {
    const storage = createMemoryStorage();

    for (let index = 0; index < 50; index += 1) {
      storage.set(String(index), entry(String(index)));
    }

    expect(Array.from(storage.keys())).toHaveLength(50);
  });

  it("deletes by prefix and reports how many entries went", () => {
    const storage = createMemoryStorage();

    storage.set("resource:/users", entry("resource:/users"));
    storage.set("resource:/users/1", entry("resource:/users/1"));
    storage.set("resource:/profile", entry("resource:/profile"));

    expect(storage.deletePrefix("resource:/users")).toBe(2);
    expect(Array.from(storage.keys())).toEqual(["resource:/profile"]);
    expect(storage.deletePrefix("nothing:")).toBe(0);
  });
});

describe("deletePrefix", () => {
  it("prefers a storage's own implementation", async () => {
    const storage = createMemoryStorage();

    storage.set("a:1", entry("a:1"));
    storage.set("b:1", entry("b:1"));

    await expect(deletePrefix(storage, "a:")).resolves.toBe(1);
    expect(Array.from(storage.keys())).toEqual(["b:1"]);
  });

  it("falls back to keys() and awaits an async backend", async () => {
    const entries = new Map<string, CacheEntry>([
      ["a:1", entry("a:1")],
      ["a:2", entry("a:2")],
      ["b:1", entry("b:1")],
    ]);
    const storage: RetryCacheStorage = {
      async get(key) {
        return entries.get(key);
      },
      async set(key, value) {
        entries.set(key, value);
      },
      async delete(key) {
        return entries.delete(key);
      },
      async clear() {
        entries.clear();
      },
      async keys() {
        return Array.from(entries.keys());
      },
    };

    await expect(deletePrefix(storage, "a:")).resolves.toBe(2);
    expect(Array.from(entries.keys())).toEqual(["b:1"]);
  });

  it("does not count keys the backend refused to delete", async () => {
    const storage: RetryCacheStorage = {
      get: () => undefined,
      set: () => undefined,
      delete: () => false,
      clear: () => undefined,
      keys: () => ["a:1", "a:2"],
    };

    await expect(deletePrefix(storage, "a:")).resolves.toBe(0);
  });

  it("throws instead of silently reporting zero without key support", async () => {
    const storage: RetryCacheStorage = {
      get: () => undefined,
      set: () => undefined,
      delete: () => false,
      clear: () => undefined,
    };

    await expect(deletePrefix(storage, "a:")).rejects.toThrow(
      "Storage backend does not support prefix invalidation.",
    );
  });
});
