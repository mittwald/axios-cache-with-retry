import { isDead } from "./cache.js";
import type {
  Awaitable,
  CacheEntry,
  InvalidationTarget,
  RetryCacheStorage,
} from "./types.js";

export interface MemoryStorageOptions {
  maxEntries?: number;
  sweepInterval?: number;
}

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_SWEEP_INTERVAL = 5 * 60_000;

export class MemoryRetryCacheStorage<
  T = unknown,
> implements RetryCacheStorage<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private lastSweep = Date.now();

  constructor(private readonly options: MemoryStorageOptions = {}) {}

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);

    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }

    return entry;
  }

  set(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.sweep();
    this.enforceMaxEntries();
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): Iterable<string> {
    return this.entries.keys();
  }

  deletePrefix(prefix: string): number {
    let deleted = 0;

    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && this.entries.delete(key)) {
        deleted += 1;
      }
    }

    return deleted;
  }

  private sweep(): void {
    const now = Date.now();
    const interval = this.options.sweepInterval ?? DEFAULT_SWEEP_INTERVAL;

    if (now - this.lastSweep < interval) {
      return;
    }

    this.lastSweep = now;

    for (const [key, entry] of this.entries) {
      if (isDead(entry, now)) {
        this.entries.delete(key);
      }
    }
  }

  private enforceMaxEntries(): void {
    const maxEntries = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;

    if (this.entries.size <= maxEntries) {
      return;
    }

    const overflow = this.entries.size - maxEntries;
    const keys = this.entries.keys();

    for (let index = 0; index < overflow; index += 1) {
      const next = keys.next();

      if (next.done) {
        return;
      }

      this.entries.delete(next.value);
    }
  }
}

export function createMemoryStorage<T = unknown>(
  options?: MemoryStorageOptions,
) {
  return new MemoryRetryCacheStorage<T>(options);
}

export async function deletePrefix(
  storage: RetryCacheStorage,
  prefix: string,
): Promise<number> {
  if (storage.deletePrefix) {
    return storage.deletePrefix(prefix);
  }

  if (!storage.keys) {
    throw new Error("Storage backend does not support prefix invalidation.");
  }

  let deleted = 0;
  const keys = await storage.keys();

  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    const didDelete = await storage.delete(key);

    if (didDelete) {
      deleted += 1;
    }
  }

  return deleted;
}

export async function deleteWhere(
  storage: RetryCacheStorage,
  predicate: (target: InvalidationTarget) => boolean,
): Promise<number> {
  if (!storage.keys) {
    throw new Error("Storage backend does not support predicate invalidation.");
  }

  let deleted = 0;
  const keys = Array.from(await storage.keys());

  for (const key of keys) {
    const entry = await storage.get(key);

    if (!predicate({ key, ...entry?.request })) {
      continue;
    }

    if (await storage.delete(key)) {
      deleted += 1;
    }
  }

  return deleted;
}

export async function maybeAwait<T>(value: Awaitable<T>): Promise<T> {
  return value;
}
