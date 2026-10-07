import type { InvalidationTarget, RetryCacheStorage } from "./types.js";

export interface Flight {
  readonly detached: boolean;
  land(): void;
}

interface TrackedFlight {
  target: InvalidationTarget;
  detached: boolean;
  onDetach?: () => void;
}

/**
 * Requests in flight per key, so an invalidation can detach them: a detached
 * request leaves the dedupe map and does not store its response.
 */
export class Flights {
  private readonly byKey = new Map<string, Set<TrackedFlight>>();

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
