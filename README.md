# @mittwald/axios-cache-with-retry

Cache, retry and merging of identical requests for Axios, in one adapter, so the
three don't trip over each other. Built by [mittwald](https://www.mittwald.de).

[![npm](https://img.shields.io/npm/v/@mittwald/axios-cache-with-retry?logo=npm&color=cb0000)](https://www.npmjs.com/package/@mittwald/axios-cache-with-retry)
[![Tests](https://img.shields.io/github/actions/workflow/status/mittwald/axios-cache-with-retry/test.yml?branch=main&logo=github&label=tests)](https://github.com/mittwald/axios-cache-with-retry/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![axios ^1](https://img.shields.io/badge/axios-%5E1-5a29e4.svg?logo=axios&logoColor=white)](https://axios-http.com)
[![Types included](https://img.shields.io/badge/types-included-3178c6.svg?logo=typescript&logoColor=white)](src/types.ts)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

- 📦 **npm:** <https://www.npmjs.com/package/@mittwald/axios-cache-with-retry>
- 📝 **Release notes:**
  <https://github.com/mittwald/axios-cache-with-retry/releases>
- 🐛 **Issues:** <https://github.com/mittwald/axios-cache-with-retry/issues>

## Highlights

- 🗄️ **Cache** with a TTL, an optional fallback to expired answers while the
  backend is down, and a bounded in-memory store.
- 🔁 **Retry** with growing pauses, `Retry-After` support and an upper bound.
- 🤝 **Merging** of identical requests that run at the same time.
- 🧹 **Invalidation** by key, prefix or URL that also reaches requests still on
  their way.
- 🧩 **One adapter** instead of three interceptors, so a retry never runs
  through the cache again and `validateStatus` doesn't change what gets retried.

## Quick start

```bash
npm install @mittwald/axios-cache-with-retry
```

`axios` is a peer dependency (`^1`).

```ts
import axios from "axios";
import { setupAxiosRetryCache } from "@mittwald/axios-cache-with-retry";

const client = setupAxiosRetryCache(axios.create({ baseURL: "/api" }));

await client.get("/users"); // goes to the network
await client.get("/users"); // answered from the cache for the next 60 s
```

That is all it takes for sensible defaults:

- `GET` and `HEAD` responses with a 2xx status are cached for 60 seconds, in
  memory, for at most 1024 different requests.
- Identical requests that run at the same time are sent once and share the
  answer.
- `GET`, `HEAD` and `OPTIONS` are retried twice on network errors and on 408,
  425, 429 and 5xx, with growing pauses (or as long as `Retry-After` says, up to
  30 s).

`setupAxiosRetryCache` returns the same instance with an added `retryCache`
property for managing the cache.

## What happens to a request

1. **A key is built** from method, base URL, URL, `params` and, for methods
   other than `GET` and `HEAD`, the body. Requests with the same key count as
   the same request. Headers are not part of the key.
2. **Fresh entry in the cache?** Then that is the answer, no request is sent.
3. **The same request already running?** Then this caller waits for it and gets
   its own copy of the result. This only happens for reads (`GET`, `HEAD`,
   `OPTIONS` and methods listed in `cache.methods`); writes are always sent.
4. **Otherwise the request is sent**, and retried if the method and the outcome
   allow it.
5. **The final answer is stored** if it is a 2xx and the method is cached. If
   every attempt failed and `staleIfError` is on, an expired entry is returned
   instead of the error.

## Recipes

### A browser app with server-side change events

Cache reads, and throw away what the server says has changed. `invalidateWhere`
matches on the URL, so you don't have to know how keys are built:

```ts
const client = setupAxiosRetryCache(axios.create({ baseURL: "/api" }), {
  cache: { ttl: 5 * 60_000 },
});

events.on("changed", async (path: string) => {
  await client.retryCache.invalidateWhere(
    ({ url }) => url?.startsWith(path) ?? false,
  );
});
```

An invalidation also reaches requests that are still running: the next caller
starts a fresh request instead of waiting for one that began before the change,
and the old answer is not stored.

### A server that serves many users

The default key ignores headers, so on a shared instance user B could get user
A's cached answer. Keep only the retries:

```ts
const client = setupAxiosRetryCache(axios.create(), {
  cache: false,
  dedupe: false,
});
```

If you do want a cache there, put the user into the key (see
[Logout and per-user data](#logout-and-per-user-data)).

### Objects that appear a moment after they were created

Some backends create objects asynchronously, so a read right after a write can
answer 404 for a short time. Retry those quickly, and give up fast when the 404
is real:

```ts
const client = setupAxiosRetryCache(axios.create(), {
  retry: {
    retries: 2,
    shouldRetry: ({ response }) => response?.status === 404,
    delay: ({ attempt }) => attempt ** 2 * 100, // 100 ms, then 400 ms
  },
});
```

`shouldRetry` replaces the built-in decision (methods, status codes, network
errors), so it applies to every method here.

### Keep working while the backend is down

`ttl` is how long an answer is used without asking the server again.
`maxStaleAge` is how much longer an expired answer may stand in when the server
cannot be reached:

```ts
const client = setupAxiosRetryCache(axios.create(), {
  cache: { ttl: 5 * 60_000, staleIfError: true, maxStaleAge: 60 * 60_000 },
});
```

For the first 5 minutes the cache answers. After that every request goes to the
server; if it fails after all retries, the old answer is returned, for up to one
more hour. After that the caller gets the error and the entry is deleted.

### A search sent as POST

`POST` is neither cached nor merged by default. Opt in for the one request that
is really a read; the default key includes the body, so different searches stay
apart:

```ts
await client.post(
  "/search",
  { query: "invoices" },
  { retryCache: { cache: { methods: ["post"] } } },
);
```

If you write your own `requestKey`, include the body for such requests, or two
different searches get the same answer.

### Logout and per-user data

Clear the cache when the user changes, so nothing from the previous user is
shown. Responses that are still on their way are not stored either:

```ts
await client.retryCache.clear();
```

To keep several users apart in one cache, build on the default key:

```ts
import { defaultRequestKey } from "@mittwald/axios-cache-with-retry";

const client = setupAxiosRetryCache(axios.create(), {
  requestKey: ({ config }) => {
    const key = defaultRequestKey(config);
    return key && `${currentUserId()} ${key}`;
  },
});
```

Returning `undefined` from `requestKey` excludes a request from cache and
merging.

### Opting single requests out

```ts
await client.get("/users", { retryCache: { retry: { retries: 5 } } });
await client.get("/metrics", { retryCache: { cache: false } });
await client.get("/live", { retryCache: { dedupe: false } });
await client.get("/raw", { retryCache: false }); // straight to the network
```

### Your own storage, with error reporting

Any object with `get`, `set`, `delete` and `clear` works as storage, and every
method may be async. A storage that fails never fails a request (it just runs
uncached), so report the errors to notice it:

```ts
const prefix = "http-cache:";

const client = setupAxiosRetryCache(axios.create(), {
  storage: {
    get: async (key) => {
      const value = await redis.get(prefix + key);
      return value ? JSON.parse(value) : undefined;
    },
    set: async (key, entry) => {
      await redis.set(prefix + key, JSON.stringify(entry));
    },
    delete: async (key) => (await redis.del(prefix + key)) > 0,
    clear: async () => {
      const keys = await redis.keys(prefix + "*");
      if (keys.length > 0) await redis.del(...keys);
    },
    keys: async () =>
      (await redis.keys(prefix + "*")).map((key) => key.slice(prefix.length)),
  },
  onStorageError: ({ operation, key, error }) => {
    logger.warn({ operation, key, error }, "retry cache storage failed");
  },
});
```

`keys` is optional; `invalidatePrefix` and `invalidateWhere` need it.

## Reference

### `cache`

| Option         | Default          | Description                                                  |
| -------------- | ---------------- | ------------------------------------------------------------ |
| `enabled`      | `true`           | Set to `false` to keep the cache off until a request opts in |
| `ttl`          | `60000`          | How long an entry is answered from the cache, in ms          |
| `methods`      | `["get","head"]` | Methods whose responses are cached                           |
| `staleIfError` | `false`          | Return an expired entry when every attempt failed            |
| `maxStaleAge`  | unlimited        | How long after expiry `staleIfError` may use an entry, in ms |
| `shouldCache`  | 2xx status       | Decides whether a response is stored                         |

An entry written without `staleIfError` is gone at expiry, also for a later
request that has `staleIfError` on.

### `retry`

| Option                | Default                             | Description                                                             |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `enabled`             | `true`                              | Set to `false` to keep retry off until a request opts in                |
| `retries`             | `2`                                 | Attempts after the first one                                            |
| `methods`             | `["get","head","options"]`          | Methods that may be retried                                             |
| `retryOnStatus`       | `408, 425, 429, 500, 502, 503, 504` | Status codes that trigger a retry                                       |
| `retryOnNetworkError` | `true`                              | Retry errors without a response                                         |
| `respectRetryAfter`   | `true`                              | Wait as long as a `Retry-After` header asks                             |
| `delay`               | 100 ms, doubling, at most 30 s      | Fixed ms or a function of the attempt                                   |
| `maxDelay`            | `30000`                             | Upper bound for every pause, `Infinity` for none; must be a number >= 0 |
| `shouldRetry`         | none                                | Replaces the decision on methods, status codes and network errors       |

A `Retry-After` above `maxDelay` ends the retries, even when `shouldRetry`
returns `true`: the caller gets that response at once. A configured `delay`
above `maxDelay` is cut to it.

### `requestKey`, `dedupe`, `storage`, `onStorageError`

| Option           | Default                 | Description                                                    |
| ---------------- | ----------------------- | -------------------------------------------------------------- |
| `requestKey`     | `defaultRequestKey`     | Function of `{ config }`; `undefined` excludes a request       |
| `dedupe`         | `true`                  | Merge identical reads that run at the same time                |
| `storage`        | `createMemoryStorage()` | Where entries live                                             |
| `onStorageError` | none                    | Called with `{ operation, key, error }` when the storage fails |

`defaultRequestKey(config)` and `stableSerialize(value)` are exported for custom
keys. `stableSerialize` sorts object keys and `URLSearchParams`, so the order of
`params` doesn't matter.

`createMemoryStorage({ maxEntries, sweepInterval })` keeps at most `maxEntries`
entries (default `1024`, `Infinity` for no limit) and drops the least recently
used one. On the first write after `sweepInterval` ms (default 5 minutes) it
removes entries that can no longer be used.

`onStorageError` gets `operation` `"get"`, `"set"` or `"delete"`. It only
observes; errors it throws are swallowed.

### Per-request `retryCache`

| Value               | Effect                                           |
| ------------------- | ------------------------------------------------ |
| `false`             | Bypasses the adapter entirely                    |
| `true`              | Enables cache and retry with the global settings |
| `{ cache, retry }`  | Merges into the global settings for this request |
| `{ dedupe: false }` | Opts this request out of merging                 |

The field is typed on Axios' own `AxiosRequestConfig`.

### `client.retryCache`

| Method                        | Effect                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `get(key)`                    | The stored entry                                                                |
| `set(key, response, { ttl })` | Store a response yourself                                                       |
| `invalidate(key)`             | Delete one entry                                                                |
| `invalidatePrefix(prefix)`    | Delete every entry whose key starts with `prefix`                               |
| `invalidateWhere(predicate)`  | Delete every entry for which `predicate({ key, method, url, baseURL })` is true |
| `clear()`                     | Delete everything                                                               |

Every invalidation also detaches matching requests that are still running.
Deleting directly in the storage does not, so always go through
`client.retryCache`. Instances that share one storage are invalidated together.
Entries written by 1.0.x pass only `key` to `invalidateWhere`.

## Good to know

- **Headers are not part of the default key.** See
  [A server that serves many users](#a-server-that-serves-many-users).
- **Writes are never merged**, whatever their key: two `POST`s are two intended
  operations.
- **Only 2xx responses are cached** unless `shouldCache` says otherwise, also
  under `validateStatus: () => true`.
- **Retries look at responses and thrown errors alike**, so they work the same
  whatever `validateStatus` says.
- **A cache hit never sends a request**, and `staleIfError` only steps in after
  the last retry.
- **An abort ends the retries**, and among merged callers it only rejects the
  caller whose `signal` fired. The shared request stops once every caller has
  aborted. The deprecated `cancelToken` is not isolated this way.
- **A failing storage never fails a request**; `client.retryCache` methods do
  pass storage errors on.
- **Calling `setupAxiosRetryCache` twice** on one instance replaces the first
  setup instead of stacking two.

## Why one adapter

Retry, cache and merging are three decisions about the same request. With
interceptors they can't be combined: a retry is a second dispatch, it runs
through all interceptors again, and every other layer sees a request the caller
never made.

Take three components that ask for `GET /users` at the same time while the
server answers `503` twice and then `200`. With `axios-cache-interceptor`
merging the requests and `axios-retry` retrying them, the merged failure reaches
all three callers, and each runs its own retry loop: up to nine requests instead
of three, and whichever loop finishes first decides what gets cached. Put the
other way round, each retry looks like a new request to the cache layer while
its entry for the first attempt is still open. And whether a `503` reaches the
retry at all depends on `validateStatus`: accept it, and it is cached as a
success.

This package does all three in the adapter, the one place that wraps the actual
dispatch. One key, one shared promise for lookup, retries and write, and one
retry decision for responses and errors alike.

## License

MIT
