# Production edge and R2 package cache

## Ownership and rollout

User authorized enabling CF caching and R2 on 2026-10-15 after Host 0.10.4 acceptance.
The existing service and both domains are retained. New private Standard bucket:
`phinix-plugin-cache-production-20261015`; the historical PoC bucket is preserved.
No public R2 endpoint is required. Production uses `src/cached.mjs`, the existing
read-only request/source/limiter/token gates, and internal SQLite CacheCoordinator.
RepositoryOperations is account-internal RPC only; HTTP administration paths remain
unrouted. `wrangler.ops.production.jsonc` is a local inspection bridge, never deployed.

## Request and trust path

Validate current pinned source/publication/catalog and active package membership
before checking any package cache. Then try edge Cache API, R2, and finally the
approved upstream. Schema4 third-party themes use the verified Index Release mirror;
plugins keep their approved author assets. Cache availability never grants approval.
HEAD/304 are based on approved metadata; Range and arbitrary paths remain rejected.
All delivered bodies, including edge/R2 hits, pass the length/EOF/SHA256 verifier.
Corrupt edge bodies fail before final-byte completion and are evicted. Backend
errors, misses, operation-budget exhaustion and capacity pressure bypass to origin.

Edge fills buffer at most 8 MiB per package and two concurrent fills per isolate;
no unbounded tee/clone branch. Only a completely verified body is submitted to
Cache API, with 24-hour lifetime. Submission does not prove storage: Cache API can
silently decline it. Slow/failing R2 writes drop their cache branch without making
the verified origin response wait indefinitely. Public responses stay no-store;
internal hash-keyed storage is separate. Request no-cache forces origin metadata
revalidation, while already hash-proven immutable package bytes may be reused.
`X-Phinix-Cache` reports origin/r2/edge for diagnostic verification only.

R2 keys include source, package, version and full approved SHA256. The single SQLite
ledger reserves capacity before put and commits readiness after R2 checksum/length
acknowledgement. Interrupted or lost-ack writes retain uncertain reservations. Only
ready superseded versions may be evicted under capacity pressure; latest and
uncertain objects are not silently erased to make space. A fresh empty bucket is
checked and marked at bootstrap; a lost ledger cannot silently adopt existing data.

## Bounds and period behavior

Capacity: 256 MiB including accounting overhead, 256 tracked records, 8 MiB maximum
fill size. Larger packages still stream from origin. Per UTC calendar month, local
cache budgets are 10,000 R2 Class A and 100,000 Class B operations. These are bounds
for this cache's accounted requests, not an account-wide billing guarantee.
`CACHE_BUDGET_WINDOW=utc-month` explicitly permits counter rollover only after the
old period ends. Object records, leases, uncertain capacity, paused/bootstrap states
and bucket epoch remain. Fixed-period PoC configurations retain fail-closed period
semantics. Clock rollback and epoch mismatch do not reset counters. Monthly rollover
also works after restarting the DO. No monthly deletion or rebootstrap is performed.

## Disable and rollback

Keep the new DO export, binding and migration history. Deploy both
EDGE_CACHE_ENABLED=false and R2_ENABLED=false to serve approved upstream directly;
retain stored objects for recovery. Never delete/recreate bucket or ledger to reset
budgets. A pre-DO Worker version may be incompatible with the lifecycle migration,
so do not promise pre-migration wrangler rollback as the cache shutdown method.
Do not deploy the historical PoC or either local operations bridge.

## Validation before deployment

170 Node tests passed, including edge origin/fill/hit, R2 refill after edge eviction,
withdrawal before cache lookup, corrupt origin/edge rejection, cache faults,
concurrency/memory bounds, month rollover with/without restart, paused/uncertain
reservation preservation and clock rollback. Native workerd verified the production
entrypoint, real Cache API edge hit, SQLite DO/R2 fill, fixed-length verified streams,
limiter binding, internal RPC and lost-ack recovery. Formal configuration dry-run
passed. Deployment version and real live cache evidence are recorded after rollout;
local tests do not establish a live cache hit.

Primary platform references:
- https://developers.cloudflare.com/workers/runtime-apis/cache/
- https://developers.cloudflare.com/workers/reference/how-the-cache-works/
- https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
