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
| `maxStaleAge`  | unlimited        | How long after expiry `staleIfError` may serve an entry, ms  |
| `shouldCache`  | 2xx status       | Predicate deciding whether a response is stored              |

### `retry`

| Option                | Default                             | Description                                                                                         |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `enabled`             | `true`                              | Set to `false` to keep retry off until a request opts in                                            |
| `retries`             | `2`                                 | Attempts after the initial one                                                                      |
| `methods`             | `["get","head","options"]`          | Methods that may be retried                                                                         |
| `retryOnStatus`       | `408, 425, 429, 500, 502, 503, 504` | Status codes that trigger a retry                                                                   |
| `retryOnNetworkError` | `true`                              | Retry errors that never produced a response                                                         |
| `respectRetryAfter`   | `true`                              | Honour a `Retry-After` response header                                                              |
| `delay`               | exponential, capped at 30 s         | Fixed milliseconds or a function; the backoff stays at 30 s even with a larger `maxDelay`           |
| `maxDelay`            | `30000`                             | Upper bound for every delay, `Infinity` for none; anything but a number >= 0 throws                 |
| `shouldRetry`         | —                                   | Replaces the built-in decision, except that a `Retry-After` above `maxDelay` still ends the retries |

### `requestKey`

Cache and dedupe key for a request. Defaults to method, base URL, URL, a stably
serialized `params` and — for non-`GET`/`HEAD` — a stably serialized body.
Returning `undefined` excludes the request from both caching and deduplication.

The key alone decides what counts as the same request. Headers are not part of
the default key, `Authorization` included, so two requests to the same URL with
different credentials share one cache entry and, while one of them is in flight,
one request. In a browser tab with a single user that is what you want. On a
server, where one axios instance serves many users, it hands one user's response
to another: there, either turn cache and dedupe off or use a `requestKey` that
includes the user.

`defaultRequestKey(config)` and `stableSerialize(value)` are exported, so a
custom key can build on the default or reuse its serialization, which sorts
object keys and `URLSearchParams`:

```ts
import {
  defaultRequestKey,
  stableSerialize,
} from "@mittwald/axios-cache-with-retry";

const requestKey = ({ config }) =>
  config.url?.startsWith("/search")
    ? `search:${config.url}:${stableSerialize(config.data)}`
    : defaultRequestKey(config);
```

### `storage`

Defaults to an in-memory store, or pass any object implementing
`RetryCacheStorage`; every method may return a promise, so an async backend
works as well.

`createMemoryStorage({ maxEntries, sweepInterval })` keeps at most `maxEntries`
entries (default `1024`, `Infinity` for no limit) and evicts the least recently
read or written one. On the first write after `sweepInterval` milliseconds
(default five minutes) it also removes entries that can no longer be served.

An entry can no longer be served once its `staleUntil` has passed: right at
expiry when it was written without `staleIfError`, `maxStaleAge` after expiry
with it, and never without `maxStaleAge`. A request that reads such an entry
deletes it, whatever the storage.

### `onStorageError`

Called when the cache layer swallows a storage error, so a storage that is down
shows up in logs or metrics instead of only as uncached requests:

```ts
setupAxiosRetryCache(instance, {
  storage,
  onStorageError: ({ operation, key, error }) => {
    logger.warn({ operation, key, error }, "retry cache storage failed");
  },
});
```

`operation` is `"get"` or `"set"`. The callback only observes: the request
behaves the same with or without it, and an error the callback throws, or a
promise it returns that rejects, is swallowed as well.

## Cache API

`client.retryCache` exposes `get`, `set`, `invalidate`, `invalidatePrefix`,
`invalidateWhere` and `clear`. `invalidatePrefix` needs a storage that
implements either `deletePrefix` or `keys` — the built-in memory storage
implements both.

`invalidateWhere(predicate)` deletes every entry the predicate matches and
returns how many it deleted. The predicate gets `{ key, method, url, baseURL }`,
taken from the request that stored the entry, so a consumer can match on the URL
without parsing its own key format. An entry stored without that information
passes only `key`. It needs a storage that implements `keys`.

```ts
await client.retryCache.invalidateWhere(
  ({ url }) => url?.startsWith("/tickets/") ?? false,
);
```

An invalidation also reaches requests in flight with a matching key: the next
caller starts a new request instead of joining one that began before, and the
response of the earlier request is not stored. Callers that were already waiting
still get it, but never the stale entry from before the invalidation: with
`staleIfError`, a detached request that fails rejects. This only works through
`client.retryCache`, which covers every instance set up on the same storage;
deleting entries in the storage directly leaves requests in flight untouched.
`invalidatePrefix` matches requests in flight by plain string prefix, whatever
rules a custom storage's `deletePrefix` applies to stored keys.

## Behaviour worth knowing

- **Deduplication wraps the whole operation**, retries included: concurrent
  callers with the same key wait for one shared result and each receive their
  own shallow copy, carrying their own `config`. A failure reaches every caller
  as its own copy of the error.
- **Writes are not deduplicated.** Two concurrent writes are two intended
  operations, so each one reaches the network, whatever its key. Merged are the
  safe methods (`GET`, `HEAD`, `OPTIONS`) and the methods listed in
  `cache.methods`, such as a search sent as `POST`, which that list declares
  reads.
- **The request key decides what counts as one request.** Requests with the same
  key share a cache entry and, while one of them is in flight, its result. The
  default key carries the body for every method except `GET` and `HEAD`. A
  custom key for a method in `cache.methods` has to carry it as well, or two
  searches with different bodies get the same answer.
- **A cache hit short-circuits before retry**, so a cached response never
  produces a request.
- **`staleIfError` only serves an expired entry after retries are exhausted**,
  never instead of a retry.
- **Only 2xx responses are cached by default, never errors.** A 404 that
  `validateStatus` accepts is not stored either, unless `shouldCache` says so.
- **A failing storage never fails a request.** A read that throws counts as a
  miss, and a write that throws leaves the response uncached. A throwing
  `shouldCache` still rejects the request, and `client.retryCache` passes
  storage errors on. `onStorageError` reports what the cache layer swallows.
- **`Retry-After` above `maxDelay` ends the retries.** The caller gets the
  response that carried the header at once instead of waiting, since a retry
  before that time is expected to fail again. A configured `delay` above
  `maxDelay` is capped at it.
- **An abort ends the retries.** A canceled request is never retried, and an
  abort during a retry delay rejects at once instead of starting the next
  attempt.
- **Merged callers abort on their own.** An abort rejects only the caller whose
  `signal` fired; the shared request keeps running for the others and is aborted
  once every caller waiting for it has aborted. The deprecated `cancelToken` is
  not isolated this way.

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
