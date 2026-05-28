import type { Awaitable, CacheEntry, RetryCacheStorage } from "./types.js";

export interface MemoryStorageOptions {
  maxEntries?: number;
}

export class MemoryRetryCacheStorage<
  T = unknown,
> implements RetryCacheStorage<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly options: MemoryStorageOptions = {}) {}

  get(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CacheEntry<T>): void {
    this.entries.set(key, entry);
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

  private enforceMaxEntries(): void {
    const { maxEntries } = this.options;

    if (!maxEntries || this.entries.size <= maxEntries) {
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

export async function maybeAwait<T>(value: Awaitable<T>): Promise<T> {
  return value;
}
