import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";
import type { RequestKeyContext } from "../src/types.js";
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

  it("separates requests by Authorization", () => {
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({ Authorization: "Bearer alice" }),
        }),
      ),
    ).not.toBe(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({ Authorization: "Bearer bob" }),
        }),
      ),
    );
  });

  it("appends a digest of the credentials as the last segment", () => {
    const key = defaultRequestKey(
      config({
        url: "/users/self",
        headers: new AxiosHeaders({ Authorization: "Bearer alice" }),
      }),
    );

    expect(key).toMatch(/^get {2}\/users\/self {3}[0-9a-f]{32}$/);
    expect(key).not.toContain("alice");
  });

  it("gives a text body that ends in a digest the key of those credentials", () => {
    const withCredentials = defaultRequestKey(
      config({
        method: "post",
        url: "/search",
        data: "q",
        headers: new AxiosHeaders({ Authorization: "Bearer victim" }),
      }),
    );
    const digest = withCredentials?.split(" ").at(-1);

    expect(
      defaultRequestKey(
        config({ method: "post", url: "/search", data: `q ${digest}` }),
      ),
    ).toBe(withCredentials);
  });

  it("gives the same credentials the same key, whatever the header casing and order", () => {
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({
            Authorization: "Bearer alice",
            Cookie: "session=alice",
          }),
        }),
      ),
    ).toBe(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({
            cookie: "session=alice",
            authorization: "Bearer alice",
          }),
        }),
      ),
    );
  });

  it("treats an empty or false credential header as none", () => {
    const anonymous = defaultRequestKey(config({ url: "/users/self" }));

    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({ Authorization: "" }),
        }),
      ),
    ).toBe(anonymous);
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({ Authorization: false }),
        }),
      ),
    ).toBe(anonymous);
  });

  it("treats an empty array in a credential header as none", () => {
    const anonymous = defaultRequestKey(config({ url: "/users/self" }));

    for (const cookie of [[], [""]]) {
      expect(
        defaultRequestKey(
          config({
            url: "/users/self",
            headers: new AxiosHeaders({ Cookie: cookie }),
          }),
        ),
      ).toBe(anonymous);
    }
  });

  it("keeps an array with a value in a credential header", () => {
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({ Cookie: ["", "session=alice"] }),
        }),
      ),
    ).not.toBe(defaultRequestKey(config({ url: "/users/self" })));
  });

  it("moves the userinfo of a URL into the digest", () => {
    const alice = defaultRequestKey(
      config({ baseURL: "https://alice:secret@api.test", url: "/users" }),
    );

    expect(alice).toMatch(/^get https:\/\/api\.test \/users {3}[0-9a-f]{32}$/);
    expect(alice).not.toBe(
      defaultRequestKey(
        config({ baseURL: "https://bob:secret@api.test", url: "/users" }),
      ),
    );
    expect(
      defaultRequestKey(config({ url: "https://alice:secret@api.test/users" })),
    ).toMatch(/^get {2}https:\/\/api\.test\/users {3}[0-9a-f]{32}$/);
    expect(
      defaultRequestKey(
        config({ baseURL: "https://alice:p@ss@api.test", url: "/users" }),
      ),
    ).toMatch(/^get https:\/\/api\.test \/users {3}[0-9a-f]{32}$/);
  });

  it("moves an access_token in the params or the url into the digest", () => {
    const fromObject = defaultRequestKey(
      config({ url: "/users", params: { access_token: "secret", page: 2 } }),
    );
    const fromSearchParams = defaultRequestKey(
      config({
        url: "/users",
        params: new URLSearchParams([
          ["access_token", "secret"],
          ["page", "2"],
        ]),
      }),
    );
    const fromUrl = defaultRequestKey(
      config({ url: "/users?access_token=secret&page=2" }),
    );

    expect(fromObject).toMatch(/^get {2}\/users \{"page":2\} {2}[0-9a-f]{32}$/);
    expect(fromSearchParams).toMatch(
      /^get {2}\/users \[\["page","2"\]\] {2}[0-9a-f]{32}$/,
    );
    expect(fromUrl).toMatch(/^get {2}\/users\?page=2 {3}[0-9a-f]{32}$/);
    expect(fromObject).not.toBe(
      defaultRequestKey(
        config({ url: "/users", params: { access_token: "other", page: 2 } }),
      ),
    );
  });

  it("adds authParams to access_token instead of replacing it", () => {
    const keyOf = (params: Record<string, string>) =>
      defaultRequestKey(config({ url: "/users", params }), {
        authParams: ["api_key"],
      });

    expect(keyOf({ api_key: "secret" })).not.toContain("secret");
    expect(keyOf({ access_token: "secret" })).not.toContain("secret");
    expect(
      defaultRequestKey(
        config({ url: "/users", params: { api_key: "secret" } }),
      ),
    ).toContain("secret");
  });

  it("leaves a url, params and an empty access_token without credentials as they are", () => {
    expect(defaultRequestKey(config({ url: "/users?page=2&sort=name" }))).toBe(
      "get  /users?page=2&sort=name  ",
    );
    expect(
      defaultRequestKey(config({ url: "/users?access_token=&page=2" })),
    ).toBe("get  /users?access_token=&page=2  ");
    expect(
      defaultRequestKey(
        config({ url: "/users", params: { access_token: "", page: 2 } }),
      ),
    ).toBe('get  /users {"access_token":"","page":2} ');
    expect(
      defaultRequestKey(config({ baseURL: "https://api.test", url: "/users" })),
    ).toBe("get https://api.test /users  ");
  });

  it.each([
    "https://api.test:8443/users/@alice/files?page=2&sort=name&flag&tag=a&tag=b#top",
    "http://[::1]:3000/users",
    "//api.test/users?page=2",
    "/users?q=a+b&name=%20x",
    "/users?access_token_extra=1&my_access_token=2",
    "/users?access_token=&page=2",
    "/users?access_token",
    "/users#access_token=secret",
    "mailto:alice@api.test",
  ])("leaves %s as it is without credentials", (url) => {
    expect(defaultRequestKey(config({ url }))).toBe(`get  ${url}  `);
  });

  it.each([
    [
      "https://alice:secret@api.test:8443/users?page=2#top",
      "https://api.test:8443/users?page=2#top",
    ],
    ["//alice:secret@api.test/users", "//api.test/users"],
    ["http://alice@[::1]:3000/users", "http://[::1]:3000/users"],
    ["/users?access_token=secret", "/users"],
    ["/users?page=2&access_token=secret#top", "/users?page=2#top"],
    ["/users?access_token=a&page=2&access_token=b", "/users?page=2"],
    ["/users?access%5Ftoken=secret&page=2", "/users?page=2"],
    ["/users/@alice?access_token=a+b", "/users/@alice"],
  ])("moves the credentials out of %s", (url, rest) => {
    expect(defaultRequestKey(config({ url }))).toMatch(
      new RegExp(
        `^get {2}${rest.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} {3}[0-9a-f]{32}$`,
      ),
    );
  });

  it("separates requests by config.proxy.auth", () => {
    const keyOf = (username: string) =>
      defaultRequestKey(
        config({
          url: "/users",
          proxy: {
            host: "proxy.test",
            port: 3128,
            auth: { username, password: "secret" },
          },
        }),
      );

    expect(keyOf("alice")).not.toBe(keyOf("bob"));
    expect(keyOf("alice")).toMatch(/^get {2}\/users {3}[0-9a-f]{32}$/);
  });

  it("treats an empty config.auth as none", () => {
    const anonymous = defaultRequestKey(config({ url: "/users/self" }));

    expect(
      defaultRequestKey(
        config({ url: "/users/self", auth: { username: "", password: "" } }),
      ),
    ).toBe(anonymous);
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          auth: {} as InternalAxiosRequestConfig["auth"],
        }),
      ),
    ).toBe(anonymous);
  });

  it("keeps a config.auth with a username but no password", () => {
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          auth: { username: "alice", password: "" },
        }),
      ),
    ).not.toBe(defaultRequestKey(config({ url: "/users/self" })));
  });

  it("adds authHeaders to the credential headers instead of replacing them", () => {
    const authHeaders = ["x-api-key"];
    const keyOf = (headers: Record<string, string>) =>
      defaultRequestKey(
        config({ url: "/users/self", headers: new AxiosHeaders(headers) }),
        { authHeaders },
      );

    expect(keyOf({ "X-Api-Key": "alice" })).not.toBe(
      keyOf({ "X-Api-Key": "bob" }),
    );
    expect(keyOf({ Authorization: "Bearer alice" })).not.toBe(
      keyOf({ Authorization: "Bearer bob" }),
    );
  });

  it("separates requests by Cookie and Proxy-Authorization", () => {
    const anonymous = defaultRequestKey(config({ url: "/users/self" }));

    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({ Cookie: "session=alice" }),
        }),
      ),
    ).not.toBe(anonymous);
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({
            "Proxy-Authorization": "Basic YWxpY2U6c2VjcmV0",
          }),
        }),
      ),
    ).not.toBe(anonymous);
  });

  it("separates requests by config.auth", () => {
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          auth: { username: "alice", password: "secret" },
        }),
      ),
    ).not.toBe(
      defaultRequestKey(
        config({
          url: "/users/self",
          auth: { username: "bob", password: "secret" },
        }),
      ),
    );
  });

  it("ignores any other header", () => {
    expect(
      defaultRequestKey(
        config({
          url: "/users/self",
          headers: new AxiosHeaders({
            Accept: "application/json",
            "X-Api-Key": "alice",
          }),
        }),
      ),
    ).toBe(defaultRequestKey(config({ url: "/users/self" })));
  });

  it("joins method, base url, url, params and body with spaces", () => {
    expect(
      defaultRequestKey(
        config({
          method: "post",
          baseURL: "https://api.test",
          url: "/users",
          params: { page: 2 },
          data: { name: "Ada" },
        }),
      ),
    ).toBe('post https://api.test /users {"page":2} {"name":"Ada"}');
    expect(defaultRequestKey(config({ url: "/users" }))).toBe("get  /users  ");
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

  it("hands a custom key the config, the authHeaders and the authParams", async () => {
    const request = config({ url: "/users" });
    const key = vi.fn(() => "users");

    await resolveRequestKey(key, request, { authHeaders: ["X-Api-Key"] });
    await resolveRequestKey(key, request);

    expect(key).toHaveBeenNthCalledWith(1, {
      config: request,
      authHeaders: ["X-Api-Key"],
      authParams: [],
    });
    expect(key).toHaveBeenNthCalledWith(2, {
      config: request,
      authHeaders: [],
      authParams: [],
    });
  });

  it("hands a custom key the very authHeaders array it was given", async () => {
    const authHeaders = ["X-Api-Key"];
    const key = vi.fn((ignoredContext: RequestKeyContext) => "users");

    await resolveRequestKey(key, config({ url: "/users" }), { authHeaders });

    expect(key.mock.calls[0]?.[0].authHeaders).toBe(authHeaders);
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
