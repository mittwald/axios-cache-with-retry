import type { RetryCacheStorage } from "./types.js";

export interface Flight {
  readonly detached: boolean;
  land(): void;
}

interface TrackedFlight {
  detached: boolean;
  onDetach?: () => void;
}

/**
 * Requests in flight per key, so an invalidation can detach them: a detached
 * request leaves the dedupe map and does not store its response.
 */
export class Flights {
  private readonly byKey = new Map<string, Set<TrackedFlight>>();

  track(key: string, onDetach?: () => void): Flight {
    const tracked: TrackedFlight = { detached: false, onDetach };
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

  detach(matches: (key: string) => boolean): void {
    for (const [key, flights] of this.byKey) {
      if (!matches(key)) {
        continue;
      }

      this.byKey.delete(key);

      for (const tracked of flights) {
        tracked.detached = true;
        tracked.onDetach?.();
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
