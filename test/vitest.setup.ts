import { beforeEach, vi } from "vitest";

// Node has no window. Stub one so that tests run as in a browser; tests for a
// server stub it back to undefined, and unstubGlobals resets it before each
// test.
beforeEach(() => {
  vi.stubGlobal("window", globalThis);
});
