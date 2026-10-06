# Internal cache inspection and read recovery

Historical PoC operations only. Production has no management binding; do not deploy the retired service or run destructive operations as part of repository migration.


[中文](README.zh-CN.md) · [Audit runbook](../AUDIT.md)

This tool inspects the existing SQLite Durable Object and verifies a tracked object whose R2 write acknowledgement was lost. It does not change approval, release capacity, resume a paused ledger, reset periods/counters, repair bootstrap or delete objects. The public gateway has no operations route.

## Start the local bridge

Use the standard logged-in Wrangler CLI. Check the account, service and named entrypoint in `wrangler.ops.jsonc` before connecting. Its current target is the isolated PoC Worker, not production. The target must explicitly enable `CACHE_OPERATIONS_ENABLED=true`; the default Worker config leaves it disabled. The Cloudflare account's service-binding privileges are the trust boundary; no personal GitHub token or extracted Wrangler OAuth token is used.

```sh
cd Extensions/PluginStore/RepositoryWorker
WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler dev \
  -c wrangler.ops.jsonc --ip 127.0.0.1 --port 18787 \
  --show-interactive-dev-session=false
```

Keep this local process running while using the commands below, then stop it with Ctrl+C. Do not deploy the bridge. It accepts JSON POST only on `http://127.0.0.1:18787/operations` and rejects browser Origin/Sec-Fetch-Site headers. Wrangler establishes a remote service binding to `RepositoryOperations`, which calls the existing named DO via RPC. There is no separate public administration URL or arbitrary SQL API. Local processes on this machine can use the bridge while it is running.

## Inspect and export

```sh
python3 ops/cache-ops.py --epoch poc-20261004-v1 --period poc-20261004 \
  inspect --output /tmp/cache-inspection-001.json
```

Inspection captures one SQL transaction snapshot: metadata, totals, at most 256 tracked objects and the latest 64 persistent journal records. It makes no R2 call and spends no R2 operation counter. It can inspect an expired period; a confirmation cannot run outside that period. The per-object fingerprint binds the captured SQL entry. The transient active-write indication is advisory and is checked again during confirmation. First access still constructs the DO and initializes its schema if absent; this command does not bootstrap or infer an empty bucket.

The Python tool creates a new 0600 file and refuses to overwrite it. Keep incident exports outside Git. They contain source/package identities, leases, states and request IDs, but no credential. Record the request ID and exact build alongside the snapshot.

Before making the request, the CLI prints `operations.waiting` to stderr and flushes it immediately; stdout remains the final result. The bridge logs `operations.rpc_started` and waits up to 40 seconds for RPC, then returns HTTP 503 with `OperationsRpcTimeout`. The CLI reports the actual HTTP status and correlated request ID even when the error body omits a status field. Its HTTP socket timeout is 45 seconds. A started local RPC event alone does not prove that the cloud Worker received the request; correlate cloud operations logs before attributing the timeout to ledger processing.

## Review and confirm one fixed object

```sh
python3 ops/cache-ops.py --epoch poc-20261004-v1 --period poc-20261004 \
  confirm --inspection /tmp/cache-inspection-001.json \
  --key 'SOURCE/packages/PACKAGE/VERSION/SHA256/package'
```

This prints a plan only. Add `--apply` to execute that exact plan. The server requires the same epoch/period, full identity, lease and fingerprint; only expired `writing`/`uncertain` entries with no active write qualify. A stale snapshot or changed entry is rejected. Ready, deleting and already verified entries are not confirmation targets. Inspection is not authorization to install a package.

Before R2 access, a SQL transaction reserves one Class B operation and records `cache.recovery_read_reserved`. Failure to commit prevents the GET. The tool validates stored length, R2 SHA-256 and custom source/package/version/hash metadata, then reads every byte through an incremental SHA-256 calculation. Limits are 6 seconds for lookup/idle, 30 seconds for body/hash work, 1 MiB per input chunk, the configured maximum fill size, and at most four concurrent confirmations per DO. A timed-out lookup cancels any body returned later.

Only after SQL compare-and-set commits does `cache.recovery_confirmed` report success. The entry becomes `verified`: readable under the normal ready-ledger guards, still counted as reserved, blocked from replacement fills, and excluded from eviction. This does not prove old writers have finished. Late writer outcomes cannot downgrade this state. Missing or mismatched objects, short bodies, digest faults, period expiry, SQL failure and budget exhaustion retain the reservation and historical counts. A previously paused ledger stays paused even after successful verification.

## Investigate failures

For connection failures, run `python3 ops/network-check.py` from the Worker directory. It probes only the fixed public PoC endpoint without authentication: the environment-proxy path with Python's default User-Agent, the same path with `Phinix-PluginStore-NetworkCheck/1`, then the identified client with environment proxies disabled. Redirects are not followed. It reports socket error type/errno, a proxy CONNECT rejection code when present, and bounded response markers (`Server`, `CF-Ray`, `X-Phinix-Request-Id`, content type, JSON error code and recognizable numeric Cloudflare error code). It never prints proxy URLs, credentials, raw exception messages or response bodies. Before PoC expiry, a Worker response is normally HTTP 401 with `PocAccessDenied`. A default-agent 403/1010 followed by an identified-client 401 distinguishes browser-signature rejection from failed connectivity; an unmarked 403 alone is inconclusive. The public-endpoint probe does not prove the separate preview/RPC network path works. Disabling environment proxies does not bypass a system VPN/TUN. `npm run test:network-check` verifies diagnostics using mocks without network access.

Follow `cache.operations_requested` → `cache.recovery_read_reserved` → `cache.recovery_bytes_verified` → `cache.recovery_confirmed`, or `cache.operations_rejected`/`cache.recovery_failed`. Byte verification alone is not a committed recovery. If SQL journaling fails, `cache.recovery_journal_failed` reports that the persistent reservation remains. Inspect a new snapshot after a failure; never infer free space from object absence or delete the sentinel to restart accounting.

The native test fault worker exists only in the local harness and uses its own bucket. No fault-injection routes or clock overrides are deployed. Cloud inspection is read-only acceptance; native lost-ack recovery does not prove cloud late-writer quiescence, billing limits or game networking.

References: [Workers service-binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/), [DO RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/), [remote local-development bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).

A local HTTP/RPC timeout does not cancel a remote confirmation or prove it failed. Capture a fresh inspection before retrying; retain the reservation and correlate any eventual recovery event.
