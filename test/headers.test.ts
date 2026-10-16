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
  it("stores a response with no-store", async () => {
    const { adapter } = backend({ "cache-control": "no-store" });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("stores a response with no-cache", async () => {
    const { adapter } = backend({ "cache-control": "no-cache" });
    const client = setup(adapter);

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("stores a private response on a server that turned the cache on", async () => {
    const { adapter } = backend({ "cache-control": "private" });
    const client = setup(adapter, {
      runtime: "server",
      cache: { enabled: true },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("serves a must-revalidate response stale through staleIfError", async () => {
    const { adapter, state } = backend({ "cache-control": "must-revalidate" });
    const client = setup(adapter, { cache: { ttl: 1, staleIfError: true } });

    await client.get("/users");
    await expire();
    state.failing = true;
    const stale: AxiosResponse = await client.get("/users");

    expect(stale.data).toEqual({ call: 1 });
  });

  it("lets shouldCache store a no-store response", async () => {
    const { adapter } = backend({ "cache-control": "no-store" });
    const client = setup(adapter, {
      cache: { shouldCache: () => true },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
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
