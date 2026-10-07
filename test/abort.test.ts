import { AxiosHeaders, CanceledError } from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";
import { raceAbort } from "../src/abort.js";

function config(signal?: AbortSignal): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders(), signal };
}

describe("raceAbort", () => {
  it("settles like the promise and stops listening afterwards", async () => {
    const controller = new AbortController();
    const onAbort = vi.fn();

    await expect(
      raceAbort(Promise.resolve("value"), config(controller.signal), onAbort),
    ).resolves.toBe("value");
    await expect(
      raceAbort(
        Promise.reject(new Error("failed")),
        config(controller.signal),
        onAbort,
      ),
    ).rejects.toThrow("failed");
    controller.abort();

    expect(onAbort).not.toHaveBeenCalled();
  });

  it("rejects with the request's config once the signal aborts", async () => {
    const controller = new AbortController();
    const request = config(controller.signal);
    const onAbort = vi.fn();
    const racing = raceAbort(new Promise(() => undefined), request, onAbort);

    controller.abort();

    await expect(racing).rejects.toBeInstanceOf(CanceledError);
    await expect(racing).rejects.toMatchObject({ config: request });
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.abort();

    await expect(
      raceAbort(Promise.resolve("late"), config(controller.signal), onAbort),
    ).rejects.toBeInstanceOf(CanceledError);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("only follows the promise without a signal", async () => {
    await expect(raceAbort(Promise.resolve(1), config())).resolves.toBe(1);
  });
});
