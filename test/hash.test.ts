import { describe, expect, it } from "vitest";
import { cyrb128 } from "../src/hash.js";

describe("cyrb128", () => {
  it("matches the reference implementation", () => {
    expect(cyrb128("apples")).toBe("50acd062827f24380b3124f7fbfa0716");
    expect(cyrb128("")).toBe("027ae52ecfc796215593990d4b41437c");
  });

  it("returns 32 hex digits for any input", () => {
    for (const value of ["a", "Bearer alice", "Grüße 🔑", "x".repeat(8192)]) {
      expect(cyrb128(value)).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});
