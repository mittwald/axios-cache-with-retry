import axios, {
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
} from "axios";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage,
  type RetryCacheOptions,
  setupAxiosRetryCache,
} from "../src/index.js";

/**
 * Answers 200 with the given headers and a counter, or fails while `failing` is
 * set
 */
function backend(headers: Record<string, string> = {}) {
  const state = { failing: false, calls: 0 };
  const adapter = vi.fn<AxiosAdapter>(async (config) => {
    if (state.failing) {
      throw new Error("network down");
    }

    state.calls += 1;

    return {
      config,
      data: { call: state.calls },
      status: 200,
      statusText: "OK",
      headers,
    };
  });

  return { adapter, state };
}

/** Holds every request until `answerAll` is called */
function heldBackend() {
  const answers: (() => void)[] = [];
  const adapter = vi.fn<AxiosAdapter>(
    (config) =>
      new Promise((resolve) => {
        answers.push(() =>
          resolve({
            config,
            data: {},
            status: 200,
            statusText: "OK",
            headers: {},
          }),
        );
      }),
  );

  return { adapter, answerAll: () => answers.forEach((answer) => answer()) };
}

function setup(adapter: AxiosAdapter, options: RetryCacheOptions = {}) {
  return setupAxiosRetryCache(axios.create({ adapter }), {
    retry: false,
    ...options,
  });
}

const expire = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Cache-Control", () => {
  it("does not store a response with no-store", async () => {
    const { adapter } = backend({ "cache-control": "no-store" });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not store a response with no-cache", async () => {
    const { adapter } = backend({ "cache-control": "no-cache" });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not store a private response on a server that turned the cache on", async () => {
    const { adapter } = backend({ "cache-control": "private" });
    const client = setup(adapter, {
      runtime: "server",
      cache: { enabled: true },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not serve a must-revalidate response stale through staleIfError", async () => {
    const { adapter, state } = backend({ "cache-control": "must-revalidate" });
    const client = setup(adapter, { cache: { ttl: 1, staleIfError: true } });

    await client.get("/users");
    await expire();
    state.failing = true;
    await expect(client.get("/users")).rejects.toThrow("network down");
  });

  it("does not let shouldCache store a no-store response", async () => {
    const { adapter } = backend({ "cache-control": "no-store" });
    const client = setup(adapter, {
      cache: { shouldCache: () => true },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("merges concurrent requests whose answer is no-store", async () => {
    const { adapter } = backend({ "cache-control": "no-store" });
    const client = setup(adapter, { cache: false, retry: { delay: 0 } });

    await Promise.all([client.get("/users"), client.get("/users")]);

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("stores a no-store response handed to retryCache.set", async () => {
    const { adapter } = backend({ "cache-control": "no-store" });
    const client = setup(adapter);
    const response = await client.get("/users", { retryCache: false });

    await client.retryCache.set("get  /users  ", response);
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe("Cache-Control in the request", () => {
  const optIn = { cache: { respectRequestCacheControl: true } };

  it("fetches anew for a request with no-cache and stores the fresh answer", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users");
    await client.get("/users", { headers: { "Cache-Control": "no-cache" } });
    const next: AxiosResponse = await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(next.data).toEqual({ call: 2 });
  });

  it("fetches anew for a request with max-age=0", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users");
    await client.get("/users", { headers: { "Cache-Control": "max-age=0" } });

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not store the answer to a request with no-store", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users", { headers: { "Cache-Control": "no-store" } });
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not serve a stale entry through staleIfError to a request with no-cache", async () => {
    const { adapter, state } = backend();
    const client = setup(adapter, {
      cache: { ttl: 1, staleIfError: true, respectRequestCacheControl: true },
    });

    await client.get("/users");
    await expire();
    state.failing = true;
    await expect(
      client.get("/users", { headers: { "Cache-Control": "no-cache" } }),
    ).rejects.toThrow("network down");
  });
});

describe("Cache-Control in the instance defaults", () => {
  const optIn = { cache: { respectRequestCacheControl: true } };

  it("keeps answering from the cache when every request sends no-cache", async () => {
    const { adapter } = backend();
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: false,
    });
    client.defaults.headers.common["Cache-Control"] = "no-cache";

    await client.get("/users");
    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("fetches every request anew once the request side is turned on", async () => {
    const { adapter } = backend();
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: false,
      ...optIn,
    });
    client.defaults.headers.common["Cache-Control"] = "no-cache";

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });
});

describe("Cache-Control in the request, with options", () => {
  const optIn = { cache: { respectRequestCacheControl: true } };

  it("does not serve a cached entry to a request with no-store", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users");
    await client.get("/users", { headers: { "Cache-Control": "no-store" } });

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("reads a quoted max-age of zero", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users");
    await client.get("/users", { headers: { "cache-control": 'max-age="0"' } });

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("reads a max-age without a value as zero", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users");
    await client.get("/users", { headers: { "cache-control": "max-age=" } });

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("serves the cached entry to a request with no-cache by default", async () => {
    const { adapter } = backend();
    const client = setup(adapter);
    const noCache = { headers: { "Cache-Control": "no-cache, no-store" } };

    await client.get("/users", noCache);
    await client.get("/users", noCache);

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("keeps the two switches apart", async () => {
    const response = backend({ "cache-control": "no-store" });
    const request = backend();
    const responseRulesOnly = setup(response.adapter);
    const requestSideOnly = setup(request.adapter, {
      cache: { respectCacheControl: false, respectRequestCacheControl: true },
    });
    const noCache = { headers: { "Cache-Control": "no-cache" } };

    await responseRulesOnly.get("/users");
    await responseRulesOnly.get("/users");
    await requestSideOnly.get("/users");
    await requestSideOnly.get("/users", noCache);

    expect(response.adapter).toHaveBeenCalledTimes(2);
    expect(request.adapter).toHaveBeenCalledTimes(2);
  });

  it("lets a single request ignore its own Cache-Control", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users");
    await client.get("/users", {
      headers: { "Cache-Control": "no-cache" },
      retryCache: { cache: { respectRequestCacheControl: false } },
    });

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("does not merge a no-cache request with one already running", async () => {
    const { adapter, answerAll } = heldBackend();
    const client = setup(adapter, optIn);

    const first = client.get("/users");
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
    const second = client.get("/users", {
      headers: { "Cache-Control": "no-cache" },
    });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(2));
    answerAll();
    await Promise.all([first, second]);

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not let a request join a no-cache request already running", async () => {
    const { adapter, answerAll } = heldBackend();
    const client = setup(adapter, optIn);

    const first = client.get("/users", {
      headers: { "Cache-Control": "no-cache" },
    });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
    const second = client.get("/users");
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(2));
    answerAll();
    await Promise.all([first, second]);

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not merge a no-cache request with one answered from the cache", async () => {
    const { adapter } = backend();
    const client = setup(adapter, optIn);

    await client.get("/users");
    const [, fresh] = await Promise.all([
      client.get("/users"),
      client.get("/users", { headers: { "Cache-Control": "no-cache" } }),
    ]);

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(fresh.data).toEqual({ call: 2 });
  });
});

describe("Cache-Control lifetimes", () => {
  it("keeps the ttl whatever max-age, s-maxage or Expires say", async () => {
    const { adapter } = backend({
      "cache-control": "max-age=0, s-maxage=0",
      expires: "Thu, 01 Jan 1970 00:00:00 GMT",
    });
    const client = setup(adapter, {
      runtime: "server",
      cache: { enabled: true },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe("Cache-Control options", () => {
  it("stores a no-store response with respectCacheControl: false", async () => {
    const { adapter } = backend({ "cache-control": "no-store, no-cache" });
    const client = setup(adapter, { cache: { respectCacheControl: false } });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("lets a single request turn respectCacheControl off", async () => {
    const { adapter } = backend({ "cache-control": "no-store" });
    const client = setup(adapter);
    const retryCache = { cache: { respectCacheControl: false } };

    await client.get("/users", { retryCache });
    await client.get("/users", { retryCache });
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("serves a must-revalidate response stale with respectCacheControl: false", async () => {
    const { adapter, state } = backend({ "cache-control": "must-revalidate" });
    const client = setup(adapter, {
      cache: { ttl: 1, staleIfError: true, respectCacheControl: false },
    });

    await client.get("/users");
    await expire();
    state.failing = true;
    const stale: AxiosResponse = await client.get("/users");

    expect(stale.data).toEqual({ call: 1 });
  });

  it("stores a private response in a browser", async () => {
    const { adapter } = backend({ "cache-control": "private" });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("stores a private response on a server with shared: false", async () => {
    const { adapter } = backend({ "cache-control": "private" });
    const client = setup(adapter, {
      runtime: "server",
      cache: { enabled: true, shared: false },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("does not store a private response in a browser with shared: true", async () => {
    const { adapter } = backend({ "cache-control": "private" });
    const client = setup(adapter, { cache: { shared: true } });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("takes shared from the server defaults when a request turns the cache on", async () => {
    const { adapter } = backend({ "cache-control": "private" });
    const client = setup(adapter, { runtime: "server", cache: false });

    await client.get("/users", { retryCache: { cache: true } });
    await client.get("/users", { retryCache: { cache: true } });

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("treats private with field names like private", async () => {
    const { adapter } = backend({
      "cache-control": 'private="set-cookie", max-age=60',
    });
    const client = setup(adapter, {
      runtime: "server",
      cache: { enabled: true },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not serve a proxy-revalidate response stale only in a shared cache", async () => {
    const shared = backend({ "cache-control": "proxy-revalidate" });
    const browser = backend({ "cache-control": "proxy-revalidate" });
    const options = { cache: { ttl: 1, staleIfError: true } } as const;
    const sharedClient = setup(shared.adapter, {
      ...options,
      cache: { ...options.cache, shared: true },
    });
    const browserClient = setup(browser.adapter, options);

    await sharedClient.get("/users");
    await browserClient.get("/users");
    await expire();
    shared.state.failing = true;
    browser.state.failing = true;

    await expect(sharedClient.get("/users")).rejects.toThrow("network down");
    await expect(browserClient.get("/users")).resolves.toMatchObject({
      data: { call: 1 },
    });
  });

  it("does not serve an s-maxage response stale in a shared cache, but does in a browser", async () => {
    const shared = backend({ "cache-control": "s-maxage=60" });
    const browser = backend({ "cache-control": "s-maxage=60" });
    const sharedClient = setup(shared.adapter, {
      cache: { ttl: 1, staleIfError: true, shared: true },
    });
    const browserClient = setup(browser.adapter, {
      cache: { ttl: 1, staleIfError: true },
    });

    await sharedClient.get("/users");
    await browserClient.get("/users");
    await expire();
    shared.state.failing = true;
    browser.state.failing = true;

    await expect(sharedClient.get("/users")).rejects.toThrow("network down");
    await expect(browserClient.get("/users")).resolves.toMatchObject({
      data: { call: 1 },
    });
  });

  it.each([
    ["No-Store", "Cache-Control"],
    ["public, NO-CACHE", "cache-control"],
    ["max-age=0, no-store", "CACHE-CONTROL"],
  ])("reads %s from the %s header", async (value, name) => {
    const { adapter } = backend({ [name]: value });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("reads a Cache-Control header given as an array", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => ({
      config,
      data: {},
      status: 200,
      statusText: "OK",
      headers: { "cache-control": ["public", "no-store"] },
    }));
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });
});

describe("Vary", () => {
  it("does not serve an entry to a request with another value of a header named in Vary", async () => {
    const { adapter } = backend({ vary: "Accept-Language" });
    const client = setup(adapter);

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await client.get("/users", { headers: { "Accept-Language": "en" } });

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not store a response with Vary: *", async () => {
    const { adapter } = backend({ vary: "*" });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("does not serve an entry of another variant stale through staleIfError", async () => {
    const { adapter, state } = backend({ vary: "Accept-Language" });
    const client = setup(adapter, { cache: { ttl: 1, staleIfError: true } });

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await expire();
    state.failing = true;
    await expect(
      client.get("/users", { headers: { "Accept-Language": "en" } }),
    ).rejects.toThrow("network down");
  });

  it("serves an entry to requests with the same values or the same absent header", async () => {
    const { adapter } = backend({ vary: "Accept-Language" });
    const client = setup(adapter);

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await client.get("/users", { headers: { "accept-language": "de" } });
    await client.get("/profile");
    await client.get("/profile");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("replaces the entry with the answer to another variant", async () => {
    const { adapter } = backend({ vary: "Accept-Language" });
    const client = setup(adapter);
    const de = { headers: { "Accept-Language": "de" } };
    const en = { headers: { "Accept-Language": "en" } };

    await client.get("/users", de);
    await client.get("/users", en);
    await client.get("/users", en);
    await client.get("/users", de);

    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("compares every field of a Vary list, whatever its spacing and casing", async () => {
    const { adapter } = backend({ vary: "Accept-Language , X-TENANT" });
    const client = setup(adapter);
    const request = (tenant: string) => ({
      headers: { "Accept-Language": "de", "X-Tenant": tenant },
    });

    await client.get("/users", request("a"));
    await client.get("/users", request("a"));
    await client.get("/users", request("b"));

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("serves an entry of another variant with vary: false", async () => {
    const { adapter } = backend({ vary: "Accept-Language, *" });
    const client = setup(adapter, { cache: { vary: false } });

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await client.get("/users", { headers: { "Accept-Language": "en" } });

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("lets a single request with vary: false take an entry stored for another variant", async () => {
    const { adapter } = backend({ vary: "Accept-Language" });
    const client = setup(adapter);

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await client.get("/users", {
      headers: { "Accept-Language": "en" },
      retryCache: { cache: { vary: false } },
    });

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("serves the matching variant stale through staleIfError", async () => {
    const { adapter, state } = backend({ vary: "Accept-Language" });
    const client = setup(adapter, { cache: { ttl: 1, staleIfError: true } });

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await expire();
    state.failing = true;

    await expect(
      client.get("/users", { headers: { "Accept-Language": "de" } }),
    ).resolves.toMatchObject({ data: { call: 1 } });
  });

  it("serves an entry handed to retryCache.set whatever the request headers", async () => {
    const { adapter } = backend({ vary: "Accept-Language" });
    const client = setup(adapter);
    const response = await client.get("/users", { retryCache: false });

    await client.retryCache.set("get  /users  ", response);
    await client.get("/users", { headers: { "Accept-Language": "en" } });

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("keeps the raw request header values out of the stored entry", async () => {
    const { adapter } = backend({ vary: "X-Api-Key" });
    const storage = createMemoryStorage();
    const client = setup(adapter, { storage });

    await client.get("/users", { headers: { "X-Api-Key": "secret-alice" } });

    expect(
      JSON.stringify([...storage.keys()].map((key) => storage.get(key))),
    ).not.toContain("secret-alice");
  });
});

describe("headers as the adapters deliver them", () => {
  const answer = (headers: AxiosHeaders) =>
    vi.fn<AxiosAdapter>(async (config) => ({
      config,
      data: {},
      status: 200,
      statusText: "OK",
      headers,
    }));

  it("reads Cache-Control from AxiosHeaders", async () => {
    const adapter = answer(new AxiosHeaders({ "Cache-Control": "no-store" }));
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("reads Vary from AxiosHeaders and compares headers from the instance defaults", async () => {
    const adapter = answer(new AxiosHeaders({ Vary: "Accept-Language" }));
    const client = setupAxiosRetryCache(
      axios.create({ adapter, headers: { "Accept-Language": "de" } }),
      { retry: false },
    );

    await client.get("/users");
    await client.get("/users");
    client.defaults.headers["Accept-Language"] = "en";
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("ignores the headers an adapter adds to config.headers when it stores Vary values", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      config.headers.set(
        "Accept-Encoding",
        "gzip, compress, deflate, br",
        false,
      );
      return {
        config,
        data: { call: calls },
        status: 200,
        statusText: "OK",
        headers: new AxiosHeaders({ Vary: "Accept-Encoding" }),
      };
    });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });
});
