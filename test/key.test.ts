import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";
import {
  defaultRequestKey,
  resolveRequestKey,
  stableSerialize,
} from "../src/key.js";

function config(
  overrides: Partial<InternalAxiosRequestConfig> = {},
): InternalAxiosRequestConfig {
  return {
    ...overrides,
    headers: overrides.headers ?? new AxiosHeaders(),
  };
}

describe("defaultRequestKey", () => {
  it("returns undefined without a url, so the request is never cached", () => {
    expect(defaultRequestKey(config())).toBeUndefined();
    expect(
      defaultRequestKey(config({ baseURL: "https://api.test" })),
    ).toBeUndefined();
  });

  it("defaults the method to get and lowercases it", () => {
    expect(defaultRequestKey(config({ url: "/users" }))).toBe(
      defaultRequestKey(config({ method: "GET", url: "/users" })),
    );
  });

  it("separates requests by method, base url and url", () => {
    const keys = new Set([
      defaultRequestKey(config({ url: "/users" })),
      defaultRequestKey(config({ method: "head", url: "/users" })),
      defaultRequestKey(config({ url: "/users", baseURL: "https://a.test" })),
      defaultRequestKey(config({ url: "/profile" })),
    ]);

    expect(keys.size).toBe(4);
  });

  it("ignores the body for get and head but not for other methods", () => {
    const withBody = { url: "/users", data: { name: "Ada" } };

    expect(defaultRequestKey(config({ ...withBody, method: "get" }))).toBe(
      defaultRequestKey(config({ url: "/users", method: "get" })),
    );
    expect(defaultRequestKey(config({ ...withBody, method: "head" }))).toBe(
      defaultRequestKey(config({ url: "/users", method: "head" })),
    );
    expect(defaultRequestKey(config({ ...withBody, method: "post" }))).not.toBe(
      defaultRequestKey(config({ url: "/users", method: "post" })),
    );
  });

  it("is stable against param and body key order", () => {
    expect(
      defaultRequestKey(config({ url: "/users", params: { b: 1, a: 2 } })),
    ).toBe(
      defaultRequestKey(config({ url: "/users", params: { a: 2, b: 1 } })),
    );
    expect(
      defaultRequestKey(
        config({ url: "/users", method: "post", data: { b: 1, a: 2 } }),
      ),
    ).toBe(
      defaultRequestKey(
        config({ url: "/users", method: "post", data: { a: 2, b: 1 } }),
      ),
    );
  });
});

describe("resolveRequestKey", () => {
  it("falls back to the default key when none is configured", async () => {
    const request = config({ url: "/users" });

    await expect(resolveRequestKey(undefined, request)).resolves.toBe(
      defaultRequestKey(request),
    );
  });

  it("awaits an asynchronous custom key", async () => {
    await expect(
      resolveRequestKey(
        async ({ config: request }) => `resource:${request.url}`,
        config({ url: "/users" }),
      ),
    ).resolves.toBe("resource:/users");
  });

  it("passes a custom undefined through, opting the request out", async () => {
    await expect(
      resolveRequestKey(() => undefined, config({ url: "/users" })),
    ).resolves.toBeUndefined();
  });
});

describe("stableSerialize", () => {
  it("treats undefined, null and the empty string as no value at all", () => {
    expect(stableSerialize(undefined)).toBe("");
    expect(stableSerialize(null)).toBe("");
    expect(stableSerialize("")).toBe("");
  });

  it("passes strings through instead of quoting them", () => {
    expect(stableSerialize("a=1")).toBe("a=1");
  });

  it("sorts nested object keys but keeps array order", () => {
    expect(stableSerialize({ b: { d: 1, c: 2 }, a: [3, 1] })).toBe(
      stableSerialize({ a: [3, 1], b: { c: 2, d: 1 } }),
    );
    expect(stableSerialize([1, 2])).not.toBe(stableSerialize([2, 1]));
  });

  it("sorts URLSearchParams by key and value, repeated keys included", () => {
    expect(
      stableSerialize(
        new URLSearchParams([
          ["tag", "retry"],
          ["q", "axios"],
          ["tag", "cache"],
        ]),
      ),
    ).toBe(
      stableSerialize(
        new URLSearchParams([
          ["q", "axios"],
          ["tag", "cache"],
          ["tag", "retry"],
        ]),
      ),
    );
  });

  it("keeps a dropped repeated param distinguishable", () => {
    expect(
      stableSerialize(
        new URLSearchParams([
          ["tag", "a"],
          ["tag", "b"],
        ]),
      ),
    ).not.toBe(stableSerialize(new URLSearchParams([["tag", "a"]])));
  });

  it("leaves class instances alone rather than sorting their keys", () => {
    class Filter {
      constructor(
        public b: number,
        public a: number,
      ) {}
    }

    expect(stableSerialize(new Filter(1, 2))).toBe(
      JSON.stringify(new Filter(1, 2)),
    );
  });
});
