import axios, { type AxiosAdapter, type AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type RequestKeyContext, setupAxiosRetryCache } from "../src/index.js";

function response(
  config: AxiosResponse["config"],
  status: number,
  data: unknown = { ok: status < 400 },
): AxiosResponse {
  return {
    data,
    status,
    statusText: String(status),
    headers: {},
    config,
    request: undefined,
  };
}

/** Answers after 5 ms, so that requests started together overlap */
function slowAdapter() {
  return vi.fn<AxiosAdapter>(async (config) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return response(config, 200);
  });
}

function urlKey() {
  return vi.fn(({ config }: RequestKeyContext) => String(config.url));
}

describe("without a window", () => {
  beforeEach(() => {
    vi.stubGlobal("window", undefined);
  });

  it("caches GET responses by default", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }));

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("merges concurrent GET requests by default", async () => {
    const adapter = slowAdapter();
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
    });

    await Promise.all([client.get("/users"), client.get("/users")]);

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("caches with a cache option that only sets the ttl", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { ttl: 10_000 },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("caches with cache: { enabled: true }", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: { enabled: true },
    });

    await client.get("/users");
    await client.get("/users");

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("caches a request that opts in with cache: true", async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) =>
      response(config, 200),
    );
    const client = setupAxiosRetryCache(axios.create({ adapter }));

    await client.get("/users", { retryCache: { cache: true } });
    await client.get("/users", { retryCache: { cache: true } });

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("merges concurrent GET requests with dedupe: true", async () => {
    const adapter = slowAdapter();
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      cache: false,
      dedupe: true,
    });

    await Promise.all([client.get("/users"), client.get("/users")]);

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("retries by default", async () => {
    let calls = 0;
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      calls += 1;
      return response(config, calls === 1 ? 503 : 200);
    });
    const client = setupAxiosRetryCache(axios.create({ adapter }), {
      retry: { delay: 0 },
    });

    const result = await client.get("/users");

    expect(result.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("calls a custom requestKey by default", async () => {
    const requestKey = urlKey();
    const client = setupAxiosRetryCache(
      axios.create({ adapter: async (config) => response(config, 200) }),
      { requestKey },
    );

    await client.get("/users");

    expect(requestKey).toHaveBeenCalledTimes(1);
  });

  it("calls a custom requestKey even with cache: false and dedupe: false", async () => {
    const requestKey = urlKey();
    const client = setupAxiosRetryCache(
      axios.create({ adapter: async (config) => response(config, 200) }),
      { cache: false, dedupe: false, requestKey },
    );

    await client.get("/users");

    expect(requestKey).toHaveBeenCalledTimes(1);
  });
});
