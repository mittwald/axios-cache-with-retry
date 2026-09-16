# AGENTS.md

Notes for working in this repository. The README documents the public API and
every option; this file only covers what the source does not say out loud and
what has bitten us before. When in doubt, read `src/setup.ts` — it is where all
of the coordination lives.

---

## Commands

`pnpm test` is the full gate and runs four things in order:
`tsc --noEmit -p tsconfig.test.json`, `eslint . --cache`, a clean build, and
`vitest run`. Run it before declaring anything done — the tests alone pass on
code that does not typecheck, because `tsconfig.json` sets `rootDir: src` and
excludes `test/**`, so only the test config ever looks at the test files. Use
`pnpm format` after editing anything; Prettier runs as an ESLint rule
(`eslint-plugin-prettier`), so a formatting slip is a lint error, and the
`pkgsort`/`sort-json` plugins mean key order in `package.json` and other JSON is
formatter-owned, not yours.

**Imports carry a `.js` extension even when the file is `.ts`** —
`import/extensions` is set to `always` and the build emits ESM with
`moduleResolution: bundler`. Writing `./types` instead of `./types.js` fails
lint and would produce an unresolvable specifier in `dist/esm`.

`noUncheckedIndexedAccess` is on, so every index access is `| undefined`; this
is why the small helpers in `src/key.ts` and `src/storage.ts` look defensive.
Unused bindings are only tolerated when their name contains `ignored`.

---

## The axios type augmentation

`src/types.ts` ends with a `declare module "axios"` block that adds
`retryCache?` to `AxiosRequestConfig`. The type parameter list must repeat
Axios' own one verbatim — `<D = any>`, unused parameter and `any` included — or
the declaration merge does not happen at all. It fails silently, by the property
simply not existing on the config type, which reads like a bug in the consumer's
code rather than here. The `eslint-disable` above it exists only to keep that
shape; do not "clean it up".

The same silence is the failure mode of **two copies of `axios` in the
dependency tree**: the augmentation lands on the copy this package resolves, and
the consumer's `config.retryCache` stops typechecking. This is the usual outcome
of consuming the package through a `link:`/`file:` dependency or a worktree
checkout, where pnpm gives the linked package its own `axios`. Reach for
`pnpm pack` plus a tarball install when verifying against a real consumer, not
`link:`. Two copies of _this_ package have a second consequence: the
`installedAdapters` guard below is module-scoped, so each copy has its own.

---

## Everything is one adapter

`setupAxiosRetryCache` replaces `instance.defaults.adapter` and returns the same
instance. Three consequences that are easy to trip over:

**Interceptors run once per logical request, not per attempt.** The retry loop
calls the captured original adapter directly, so request interceptors and
`transformRequest` do not re-run between attempts, and response interceptors
only ever see the final outcome. Anything that must happen per attempt belongs
inside `runOperation`.

**The original adapter is captured once, at setup time.** It is resolved with
`axios.getAdapter(...)`, which turns the string/array form (`"xhr"`, `"http"`)
into a callable — reading `instance.defaults.adapter` directly would hand you a
string. Assigning `defaults.adapter` after setup overwrites the wrapper and
disables the whole library without any error.

**Calling setup twice must not stack.** The module-level `installedAdapters`
WeakMap remembers the pre-wrap adapter per instance so a second call re-wraps
the original. If that bookkeeping breaks, the symptom is not a crash but
multiplied behaviour: retries squared, two cache writes per response.

**The cached snapshot predates `transformResponse`.** The adapter returns before
axios transforms the body, so storage holds the raw response and the transforms
re-run on every cache hit. Data you read back via `retryCache.get` is therefore
not what the caller saw, and a response handed to `retryCache.set` is expected
in the same pre-transform shape.

---

## Resolving options

Request options are merged over global options in `resolveEffectiveOptions`, and
two rules there are load-bearing.

`definedOptions` strips keys whose value is `undefined` before spreading.
Without it, forwarding an optional variable (`cache: { ttl, methods }` where
`methods` happens to be `undefined`) would erase the default instead of
inheriting it — the test named "does not cache post requests when optional
methods resolve to undefined" exists to pin exactly that, because the visible
effect is POST responses quietly becoming cacheable.

A feature turned off globally (`cache: false`, or `{ enabled: false }`) can only
be re-enabled per request by `true` or an explicit `enabled: true`. A partial
override like `{ cache: { ttl: 5_000 } }` on top of `cache: false` stays off by
design; it is not a merge bug.

Dedupe is checked after the early return for "neither cache nor retry is
enabled", so `dedupe: true` on its own does nothing — a request with both
features off goes straight to the original adapter.

---

## Retry

`attempt` starts at 1 and the cap is `attempt > retry.retries`, so `retries: 2`
means up to three calls in total. The cap is enforced _before_ a custom
`shouldRetry` is consulted: a custom predicate replaces the method and status
checks, never the attempt budget.

`retryDelay` checks `Retry-After` first when `respectRetryAfter` is on, so a
configured `delay` function is skipped for any response carrying that header —
typically 429s, which is exactly where people expect their own backoff to run.

**The retry decision is implemented twice in `runOperation`**, once for a
returned response and once for a thrown `AxiosError`, because whether a failure
arrives as a value or as an exception depends entirely on the caller's
`validateStatus`. Any change to retry semantics has to be made in both blocks; a
one-sided change produces a library that retries under one `validateStatus`
setting and not the other, which no single test will catch.

---

## Cache, dedupe and storage

**Cached and deduped responses share their `data` by reference.**
`cloneResponse` and `responseFromCache` copy headers and config but hand out the
same body object, so one caller mutating `response.data` mutates what the next
cache hit or concurrent dedupe caller receives.

**A cache hit flattens the headers.** The snapshot lowercases every name,
stringifies the values and joins repeated ones with `", "`; axios then re-wraps
that plain object into `AxiosHeaders` on the way out, so `.get()` keeps working
either way. What does differ is the shape underneath it: a `set-cookie` that
arrives from the network as an array comes back from the cache as one joined
string, index access by the original header casing stops resolving, and
`response.request` is `undefined`. The same boundary is why `respectRetryAfter`
indexes `headers["retry-after"]` in lowercase — the retry decision runs inside
the adapter, before axios normalizes anything, and relies on the adapter
delivering lowercased names (node's `http` and the xhr adapter both do).

**Nothing evicts on expiry.** `isFresh` is a read-time comparison; expired
entries are deliberately kept so `staleIfError` can serve them after retries are
exhausted. Bounding growth is the storage's job, and
`createMemoryStorage({ maxEntries })` drops keys in `Map` insertion order —
re-`set`ting an existing key does not move it, so this is not an LRU.

`invalidatePrefix` needs a storage implementing `deletePrefix` or `keys`; with
neither, `deletePrefix` throws rather than reporting zero deletions. Custom
backends may return promises from every method (`Awaitable<T>`).

`src/index.ts` is the entire public surface. Several helpers are exported from
their own modules for testing convenience but are not re-exported there, and are
not API.

---

## Tests

Tests never touch the network or a mock server: they pass a
`vi.fn<AxiosAdapter>` into `axios.create({ adapter })` _before_ calling
`setupAxiosRetryCache`, then assert on call counts, and set `delay: 0` so retry
loops stay instant. Because the adapter is captured at setup, swapping behaviour
mid-test needs the indirection
`axios.create({ adapter: (config) => activeAdapter(config) })` — see the
`staleIfError` test. Assert the number of adapter calls, not just the payload;
nearly every regression in this library shows up as a wrong call count.

---

## Releasing

The version in `package.json` is permanently `0.0.0` and must stay that way.
`.github/workflows/npm-publish.yml` derives the real version from the git tag
with `pnpm version from-git --no-git-tag-version` when a GitHub release is
created, so hand-bumping the manifest achieves nothing. CI tests on Node 22 and
publishes on Node 24 with npm provenance (`id-token: write`).
