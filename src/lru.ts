/** Moves a key to the end of the map, where the most recently used key sits */
export function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

/** Deletes the least recently used keys until at most `limit` are left */
export function trim<K, V>(map: Map<K, V>, limit: number): void {
  const keys = map.keys();

  while (map.size > limit) {
    const next = keys.next();

    if (next.done) {
      return;
    }

    map.delete(next.value);
  }
}
