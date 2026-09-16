# @mittwald/axios-cache-with-retry

Coordinated retry, cache and in-flight dedupe for Axios — as a single adapter
rather than three interceptors that each re-run the request behind each other's
back.

Retry and caching cannot be composed out of separate interceptors: a retry is a
second dispatch, so it re-enters the interceptor chain and every layer around it
sees a request the caller never made. Combining `axios-retry` with
`axios-cache-interceptor` therefore multiplies requests instead of deduplicating
them, and which of the two even gets to see a failure depends on
`validateStatus`. [Why this exists](#why-this-exists) walks through a concrete
example.

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

## Why this exists

Retry, cache and in-flight deduplication are three decisions about the _same_
request, but an interceptor can only see a request on its way out and a response
on its way back. It cannot wrap the dispatch itself — and a retry is by
definition a second dispatch. So an interceptor-based retry has to re-send the
config, which means re-entering the interceptor chain, which means every other
layer sees a request the caller never made. Stacking the layers is the only
composition the interceptor API offers, and both stacking orders are wrong.

The popular packages each solve one third of the problem and sit in a position
that collides with the others:

- **`axios-retry`** and **`retry-axios`** hook the response (error) path and
  retry by re-dispatching the request config.
- **`axios-cache-interceptor`** caches _and_ deduplicates concurrent requests
  from a request/response interceptor pair, with its own in-flight bookkeeping
  keyed per request.
- **`axios-cache-adapter`** (unmaintained) and **`axios-extensions`**
  (`cacheAdapterEnhancer`, `throttleAdapterEnhancer`) take the adapter position
  instead — so they cannot coexist with each other, or with anything else that
  wants to own the adapter.

### Where it snags

Three components ask for `GET /users` at the same time. The endpoint answers
`503` twice and then `200`. Retry is configured for two extra attempts, and the
cache layer deduplicates in-flight requests. One logical request, one expected
outcome: three responses out of three network calls.

**Deduplication inside the retry** (cache layer closest to the request): dedupe
collapses the three callers onto one dispatch, that dispatch fails with `503`,
and the rejection fans back out to all three callers — each of which then runs
its _own_ retry handler, because each call walks the interceptor chain
separately. Three retry loops instead of one, up to nine network calls for one
logical `GET`, and whichever loop happens to finish first decides what ends up
in the cache while the others are still retrying.

**Retry inside the deduplication** (retry layer closest to the request): every
re-dispatch looks like a brand-new request to the cache layer above it, while
that layer's in-flight entry for the first attempt is still open and still
waiting to be settled by an attempt that has already been abandoned. Depending
on how the cache keys its pending state, the second attempt either registers
alongside the first — so the entry that gets stored is not the response the
caller received — or waits on a promise the retry loop is never going to fulfil.

**And the two layers disagree about what a failure is.** Retry lives on the
error path, the cache lives on the success path, and which one a `503` takes is
the caller's `validateStatus` setting. Accept non-2xx responses and the retry
handler is never invoked at all, while the cache stores the `503` and serves it
for the rest of its TTL.

### What this package does instead

All three concerns live in a single adapter, the one place that _does_ wrap the
dispatch. One request key is resolved once, and one shared in-flight promise
covers the entire operation: the cache lookup, the retry loop, and the cache
write after the final attempt. Concurrent callers wait for that one result
instead of starting their own loops, retries never re-enter the interceptor
chain, and the retry decision is made for returned responses and thrown errors
alike — so `validateStatus` stops being part of the retry semantics. The
guarantees that follow from it are listed under
[Behaviour worth knowing](#behaviour-worth-knowing) above.

## License

MIT
