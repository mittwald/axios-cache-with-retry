import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cyrb128 } from "../src/hash.js";
import { defaultRequestKey } from "../src/key.js";

vi.mock("../src/hash.js", async (importOriginal) => {
  const original = await importOriginal<{ cyrb128: typeof cyrb128 }>();

  return { cyrb128: vi.fn(original.cyrb128) };
});

function keyFor(token: string) {
  return defaultRequestKey({
    url: "/users/self",
    headers: new AxiosHeaders({ Authorization: `Bearer ${token}` }),
  } as InternalAxiosRequestConfig);
}

describe("the digest of the credentials", () => {
  beforeEach(() => {
    vi.mocked(cyrb128).mockClear();
  });

  it("is computed once and then reused", () => {
    const first = keyFor("alice");

    expect(keyFor("alice")).toBe(first);
    expect(keyFor("alice")).toBe(first);
    expect(cyrb128).toHaveBeenCalledTimes(1);
  });

  it("is computed again once 1024 other credentials were used since", () => {
    keyFor("bob");

    for (let index = 0; index < 1024; index += 1) {
      keyFor(`bob-${index}`);
    }

    vi.mocked(cyrb128).mockClear();
    keyFor("bob");

    expect(cyrb128).toHaveBeenCalledTimes(1);
  });

  it("is kept after 1023 other credentials were used since", () => {
    keyFor("dave");

    for (let index = 0; index < 1023; index += 1) {
      keyFor(`dave-${index}`);
    }

    vi.mocked(cyrb128).mockClear();
    keyFor("dave");

    expect(cyrb128).not.toHaveBeenCalled();
  });

  it("is kept while it is among the 1024 most recently used", () => {
    keyFor("carol");

    for (let index = 0; index < 1023; index += 1) {
      keyFor(`carol-${index}`);
    }

    keyFor("carol");
    keyFor("carol-1023");
    vi.mocked(cyrb128).mockClear();
    keyFor("carol");

    expect(cyrb128).not.toHaveBeenCalled();
  });
});
