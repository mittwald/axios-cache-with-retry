# @mittwald/axios-cache-with-retry

Coordinated retry, cache and in-flight dedupe for Axios — as a single adapter
rather than three interceptors that each re-run the request behind each other's
back.

## Installation

```bash
npm install @mittwald/axios-cache-with-retry
```

`axios` is a peer dependency (`^1`).

## Usage

```ts
import axios from "axios";
import { setupAxiosRetryCache } from "@mittwald/axios-cache-with-retry";

const client = setupAxiosRetryCache(axios.create(), {
  requestKey: ({ config }) => `${config.method ?? "get"}:${config.url}`,
  cache: { ttl: 60_000, staleIfError: true },
  retry: { retries: 3, retryOnStatus: [408, 429, 500, 502, 503, 504] },
});

await client.get("/users");
await client.retryCache.invalidate("get:/users");
```

The retry decision is made for thrown Axios errors and for regular responses
alike, so it keeps working under `validateStatus: () => true`.

`setupAxiosRetryCache` replaces the instance's adapter and returns the same
instance, typed with an added `retryCache` property. Calling it twice on one
instance re-wraps the original adapter rather than stacking two layers.

## Per-request options

Every request config accepts a `retryCache` field that overrides the global
options for that one request. The module augments Axios' own
`AxiosRequestConfig`, so the field is typed wherever `axios` is.

```ts
await client.get("/users", { retryCache: { retry: { retries: 5 } } });
await client.get("/metrics", { retryCache: { cache: false } });
await client.get("/raw", { retryCache: false });
```

| Value               | Effect                                           |
| ------------------- | ------------------------------------------------ |
| `false`             | Bypasses the adapter entirely                    |
| `true`              | Enables cache and retry with the global settings |
| `{ cache, retry }`  | Merges into the global settings for this request |
| `{ dedupe: false }` | Opts this request out of in-flight deduplication |

## Options

### `cache`

| Option         | Default          | Description                                                  |
| -------------- | ---------------- | ------------------------------------------------------------ |
| `enabled`      | `true`           | Set to `false` to keep the cache off until a request opts in |
| `ttl`          | `60000`          | Lifetime of an entry in milliseconds                         |
| `methods`      | `["get","head"]` | Methods whose responses are cached                           |
| `staleIfError` | `false`          | Serve an expired entry once retries are exhausted            |
| `shouldCache`  | —                | Predicate deciding whether a response is stored              |

### `retry`

| Option                | Default                             | Description                                              |
| --------------------- | ----------------------------------- | -------------------------------------------------------- |
| `enabled`             | `true`                              | Set to `false` to keep retry off until a request opts in |
| `retries`             | `2`                                 | Attempts after the initial one                           |
| `methods`             | `["get","head","options"]`          | Methods that may be retried                              |
| `retryOnStatus`       | `408, 425, 429, 500, 502, 503, 504` | Status codes that trigger a retry                        |
| `retryOnNetworkError` | `true`                              | Retry errors that never produced a response              |
| `respectRetryAfter`   | `true`                              | Honour a `Retry-After` response header                   |
| `delay`               | exponential, capped at 30 s         | Fixed milliseconds or a function                         |
| `shouldRetry`         | —                                   | Replaces the built-in decision entirely                  |

### `requestKey`

Cache and dedupe key for a request. Defaults to method, base URL, URL, a stably
serialized `params` and — for non-`GET`/`HEAD` — a stably serialized body.
Returning `undefined` excludes the request from both caching and deduplication.

### `storage`

Defaults to an in-memory store. Pass `createMemoryStorage({ maxEntries })` for a
bounded one, or any object implementing `RetryCacheStorage`; every method may
return a promise, so an async backend works as well.

## Cache API

`client.retryCache` exposes `get`, `set`, `invalidate`, `invalidatePrefix` and
`clear`. `invalidatePrefix` needs a storage that implements either
`deletePrefix` or `keys` — the built-in memory storage implements both.

## Behaviour worth knowing

- **Deduplication wraps the whole operation**, retries included: concurrent
  callers with the same key wait for one shared result and each receive their
  own shallow copy.
- **A cache hit short-circuits before retry**, so a cached response never
  produces a request.
- **`staleIfError` only serves an expired entry after retries are exhausted**,
  never instead of a retry.
- **Only responses are cached, never errors.**

## License

MIT
