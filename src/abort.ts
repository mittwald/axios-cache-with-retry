import { CanceledError, type InternalAxiosRequestConfig } from "axios";

export function raceAbort<T>(
  promise: Promise<T>,
  config: InternalAxiosRequestConfig,
  onAbort?: () => void,
): Promise<T> {
  const { signal } = config;

  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(new CanceledError(undefined, config));
    };

    promise.then(
      (value) => {
        signal?.removeEventListener?.("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal?.removeEventListener?.("abort", abort);
        reject(error);
      },
    );

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener?.("abort", abort);
    }
  });
}
