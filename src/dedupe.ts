import {
  type AxiosAdapter,
  type AxiosResponse,
  CanceledError,
  type GenericAbortSignal,
} from "axios";
import { cloneResponse } from "./response.js";

interface SharedRequest {
  promise: Promise<AxiosResponse>;
  controller: AbortController;
  waiting: number;
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
      const promise = adapter({ ...config, signal: controller.signal });
      const created: SharedRequest = { promise, controller, waiting: 0 };
      const forget = () => {
        if (inflight.get(key) === created) {
          inflight.delete(key);
        }
      };

      promise.then(forget, forget);
      inflight.set(key, created);
      shared = created;
    }

    return waitFor(shared, config.signal, () => {
      if (inflight.get(key) === shared) {
        inflight.delete(key);
      }
    });
  };
}

function waitFor(
  shared: SharedRequest,
  signal: GenericAbortSignal | undefined,
  forget: () => void,
): Promise<AxiosResponse> {
  shared.waiting += 1;

  return new Promise((resolve, reject) => {
    const abort = () => {
      shared.waiting -= 1;

      if (shared.waiting === 0) {
        forget();
        shared.controller.abort();
      }

      reject(new CanceledError());
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener?.("abort", abort);
    shared.promise.then(
      (response) => {
        signal?.removeEventListener?.("abort", abort);
        resolve(cloneResponse(response));
      },
      (error: unknown) => {
        signal?.removeEventListener?.("abort", abort);
        reject(error);
      },
    );
  });
}
