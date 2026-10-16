import axios, { type AxiosAdapter, type AxiosResponse } from "axios";
import { describe, expect, it, vi } from "vitest";
import { type RetryCacheOptions, setupAxiosRetryCache } from "../src/index.js";

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
  it("serves an entry to a request with another value of a header named in Vary", async () => {
    const { adapter } = backend({ vary: "Accept-Language" });
    const client = setup(adapter);

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await client.get("/users", { headers: { "Accept-Language": "en" } });

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("stores a response with Vary: *", async () => {
    const { adapter } = backend({ vary: "*" });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("serves an entry of another variant stale through staleIfError", async () => {
    const { adapter, state } = backend({ vary: "Accept-Language" });
    const client = setup(adapter, { cache: { ttl: 1, staleIfError: true } });

    await client.get("/users", { headers: { "Accept-Language": "de" } });
    await expire();
    state.failing = true;
    const stale: AxiosResponse = await client.get("/users", {
      headers: { "Accept-Language": "en" },
    });

    expect(stale.data).toEqual({ call: 1 });
  });
});
