import { AxiosHeaders } from "axios";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";
import {
  cloneResponse,
  responseFromCache,
  snapshotResponse,
} from "../src/response.js";
import type { CacheEntry } from "../src/types.js";

function config(
  overrides: Partial<InternalAxiosRequestConfig> = {},
): InternalAxiosRequestConfig {
  return {
    ...overrides,
    headers: overrides.headers ?? new AxiosHeaders(),
  };
}

function response(overrides: Partial<AxiosResponse> = {}): AxiosResponse {
  return {
    data: { ok: true },
    status: 200,
    statusText: "OK",
    headers: {},
    config: config(),
    request: undefined,
    ...overrides,
  };
}

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    key: "resource:/users",
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
    response: {
      data: { ok: true },
      status: 200,
      statusText: "OK",
      headers: { etag: 'W/"1"' },
    },
    ...overrides,
  };
}

describe("snapshotResponse", () => {
  it("lowercases header names so a cache hit matches a live response", () => {
    const snapshot = snapshotResponse(
      response({ headers: { "Content-Type": "application/json" } }),
    );

    expect(snapshot.headers).toEqual({ "content-type": "application/json" });
  });

  it("joins repeated headers and stringifies non-string values", () => {
    const snapshot = snapshotResponse(
      response({
        headers: { "set-cookie": ["a=1", "b=2"], age: 12 },
      }),
    );

    expect(snapshot.headers).toEqual({ "set-cookie": "a=1, b=2", age: "12" });
  });

  it("drops empty values and survives headers that are not an object", () => {
    expect(
      snapshotResponse(response({ headers: { etag: undefined, vary: null } }))
        .headers,
    ).toEqual({});
    expect(snapshotResponse(response({ headers: undefined })).headers).toEqual(
      {},
    );
  });

  it("flattens AxiosHeaders into a plain record", () => {
    const snapshot = snapshotResponse(
      response({ headers: new AxiosHeaders({ ETag: 'W/"1"' }) }),
    );

    expect(snapshot.headers).toEqual({ etag: 'W/"1"' });
  });

  it("keeps the body by reference, so the cache shares it with the caller", () => {
    const live = response();
    const snapshot = snapshotResponse(live);

    expect(snapshot.data).toBe(live.data);
  });
});

describe("responseFromCache", () => {
  it("answers with the requesting config and no request object", () => {
    const request = config({ url: "/users" });
    const restored = responseFromCache(entry(), request);

    expect(restored.config).toBe(request);
    expect(restored.request).toBeUndefined();
    expect(restored.status).toBe(200);
    expect(restored.statusText).toBe("OK");
  });

  it("hands out headers as a plain object, not AxiosHeaders", () => {
    const restored = responseFromCache(entry(), config());

    expect(restored.headers).toEqual({ etag: 'W/"1"' });
    expect(restored.headers).not.toBeInstanceOf(AxiosHeaders);
  });

  it("copies the headers so a caller cannot edit the stored entry", () => {
    const cached = entry();
    const restored = responseFromCache(cached, config());

    restored.headers.etag = 'W/"2"';

    expect(cached.response.headers.etag).toBe('W/"1"');
  });

  it("shares the body with the entry, so mutating it corrupts the cache", () => {
    const cached = entry();
    const first = responseFromCache(cached, config());
    const second = responseFromCache(cached, config());

    expect(first.data).toBe(cached.response.data);
    expect(second.data).toBe(first.data);
  });
});

describe("cloneResponse", () => {
  it("gives every deduped caller its own headers and config", () => {
    const shared = response({ headers: { etag: 'W/"1"' } });
    const clone = cloneResponse(shared);

    expect(clone).not.toBe(shared);
    expect(clone.headers).not.toBe(shared.headers);
    expect(clone.headers).toEqual(shared.headers);
    expect(clone.config).not.toBe(shared.config);
    expect(clone.config).toEqual(shared.config);
  });

  it("is shallow: the body stays shared between deduped callers", () => {
    const shared = response();
    const clone = cloneResponse(shared);

    expect(clone.data).toBe(shared.data);
  });
});
