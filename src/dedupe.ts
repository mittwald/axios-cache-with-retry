import {
  type AxiosAdapter,
  type AxiosResponse,
  CanceledError,
  type InternalAxiosRequestConfig,
} from "axios";
import { raceAbort } from "./abort.js";
import type { Flights } from "./flights.js";
import { cloneError, cloneResponse } from "./response.js";

interface SharedRequest {
  promise: Promise<AxiosResponse>;
  controller: AbortController;
  waiting: number;
  forget: () => void;
}

export type InflightRequests = Map<string, SharedRequest>;

export function withDedupe(
  adapter: AxiosAdapter,
  inflight: InflightRequests,
  key: string,
  flights: Flights,
): AxiosAdapter {
  return (config) => {
    if (config.signal?.aborted) {
      return Promise.reject(new CanceledError(undefined, config));
    }

    let shared = inflight.get(key);

    if (!shared) {
      const controller = new AbortController();
      const created: SharedRequest = {
        promise: adapter({ ...config, signal: controller.signal }),
        controller,
        waiting: 0,
        forget: () => {
          if (inflight.get(key) === created) {
            inflight.delete(key);
          }
        },
      };

      const flight = flights.track(key, created.forget);
      const land = () => {
        created.forget();
        flight.land();
      };

      created.promise.then(land, land);
      inflight.set(key, created);
      shared = created;
    }

    return waitFor(shared, config);
  };
}

function waitFor(
  shared: SharedRequest,
  config: InternalAxiosRequestConfig,
): Promise<AxiosResponse> {
  shared.waiting += 1;

  return raceAbort(
    shared.promise.then(
      (response) => cloneResponse(response, config),
      (error: unknown) => {
        throw cloneError(error, config);
      },
    ),
    config,
    () => {
      shared.waiting -= 1;

      if (shared.waiting === 0) {
        shared.forget();
        shared.controller.abort();
      }
    },
  );
}
