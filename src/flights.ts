import type {
  Awaitable,
  CacheEntry,
  InvalidationTarget,
  RetryCacheStorage,
} from "./types.js";

export interface Flight {
  readonly detached: boolean;
  land(): void;
}

interface TrackedFlight {
  target: InvalidationTarget;
  detached: boolean;
  onDetach?: () => void;
}

interface Invalidation {
  matches: (target: InvalidationTarget) => boolean;
  /** Keys stored anew since the invalidation began */
  stored: Set<string>;
}

/**
 * Requests in flight per key, so an invalidation can detach them: a detached
 * request leaves the dedupe map and does not store its response. Also the
 * invalidations whose deletion still runs, so that their entries count as gone
 * right away.
 */
export class Flights {
  private readonly byKey = new Map<string, Set<TrackedFlight>>();
  private readonly invalidations = new Set<Invalidation>();

  /**
   * Detaches the matching requests in flight and hides the matching entries
   * stored before, until `deletion` settles
   */
  async invalidate<T>(
    matches: (target: InvalidationTarget) => boolean,
    deletion: () => Awaitable<T>,
  ): Promise<T> {
    this.detach(matches);
    return this.hideWhile(matches, deletion);
  }

  /** Hides the matching entries stored before, until `deletion` settles */
  async hideWhile<T>(
    matches: (target: InvalidationTarget) => boolean,
    deletion: () => Awaitable<T>,
  ): Promise<T> {
    const invalidation: Invalidation = { matches, stored: new Set() };
    this.invalidations.add(invalidation);

    try {
      return await deletion();
    } finally {
      this.invalidations.delete(invalidation);
    }
  }

  /** Records that `key` was stored after the running invalidations began */
  stored(key: string): void {
    for (const invalidation of this.invalidations) {
      invalidation.stored.add(key);
    }
  }

  /** Whether a running invalidation is deleting this entry */
  hides(entry: CacheEntry): boolean {
    for (const { matches, stored } of this.invalidations) {
      if (
        !stored.has(entry.key) &&
        matches({ key: entry.key, ...entry.request })
      ) {
        return true;
      }
    }

    return false;
  }

  track(target: InvalidationTarget, onDetach?: () => void): Flight {
    const { key } = target;
    const tracked: TrackedFlight = { target, detached: false, onDetach };
    let flights = this.byKey.get(key);

    if (!flights) {
      flights = new Set();
      this.byKey.set(key, flights);
    }

    flights.add(tracked);

    return {
      get detached() {
        return tracked.detached;
      },
      land: () => this.remove(key, tracked),
    };
  }

  detach(matches: (target: InvalidationTarget) => boolean): void {
    for (const [key, flights] of this.byKey) {
      for (const tracked of flights) {
        if (!matches(tracked.target)) {
          continue;
        }

        flights.delete(tracked);
        tracked.detached = true;
        tracked.onDetach?.();
      }

      if (flights.size === 0) {
        this.byKey.delete(key);
      }
    }
  }

  private remove(key: string, tracked: TrackedFlight): void {
    const flights = this.byKey.get(key);

    if (flights?.delete(tracked) && flights.size === 0) {
      this.byKey.delete(key);
    }
  }
}

const flightsByStorage = new WeakMap<RetryCacheStorage, Flights>();

export function flightsFor(storage: RetryCacheStorage): Flights {
  let flights = flightsByStorage.get(storage);

  if (!flights) {
    flights = new Flights();
    flightsByStorage.set(storage, flights);
  }

  return flights;
}
