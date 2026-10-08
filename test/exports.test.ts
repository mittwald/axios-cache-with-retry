import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("public surface", () => {
  it("exports the setup, the memory storage and the key helpers at runtime", () => {
    expect(Object.keys(api).sort()).toEqual([
      "MemoryRetryCacheStorage",
      "createMemoryStorage",
      "defaultRequestKey",
      "setupAxiosRetryCache",
      "stableSerialize",
    ]);
  });
});
