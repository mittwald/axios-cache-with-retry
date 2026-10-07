import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import { raceAbort } from "./abort.js";
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
): AxiosAdapter {
  return (config) => {
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

      created.promise.then(created.forget, created.forget);
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
