import type { AxiosAdapter, AxiosResponse } from "axios";
import { cloneResponse } from "./response.js";

export type InflightRequests = Map<string, Promise<AxiosResponse>>;

export function withDedupe(
  adapter: AxiosAdapter,
  inflight: InflightRequests,
  key: string,
): AxiosAdapter {
  return async (config) => {
    const existing = inflight.get(key);

    if (existing) {
      return cloneResponse(await existing);
    }

    const promise = adapter(config).finally(() => {
      inflight.delete(key);
    });

    inflight.set(key, promise);
    return cloneResponse(await promise);
  };
}
