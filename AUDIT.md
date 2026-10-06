# Audit and failure investigation

[中文](AUDIT.zh-CN.md) · [Worker scope/setup](README.md)

Start with the **gateway request ID** displayed beside the client error. Each client refresh also has a 32-character `clientRequestId`; all stable/published/catalog calls made by that transport share it. The Worker returns its UUID through `X-Phinix-Request-Id` and the bounded JSON error envelope `{code,retryable,requestId}`. The client accepts only canonical IDs/codes, rejects mismatched header/body IDs as an envelope, and falls back to the HTTP category for HTML, malformed, duplicate-field or oversized errors. Retryability is diagnostic only; no automatic retry/installation follows it.

Client JSON records use the existing host/game log with prefix `Plugin store audit:`. They record response receipt, complete bounded metadata, verified chain, staged cache, **confirmed atomic cache commit**, cleanup and failure/cancellation/timeout. Closing a window does not prevent these records. Successful metadata receipt is not chain validation or file-cache commit. A valid previous cache survives rejected refreshes; cleanup failures get their own event rather than changing an already committed result.

Worker and coordinator emit schema-versioned JSON with request ID, span ID, component, per-span sequence, UTC time and build ID. Their shared request ID joins serving and cache events; span IDs distinguish simultaneous suboperations. Source, snapshot, package/version/digest, expected/observed bytes, budgets, lease, stage and fixed reason codes are included where applicable. GitHub's own request ID is retained when safe. Each span permits 79 ordinary events, a truncation marker and one terminal event; the terminal survives truncation. Background fill can finish after the serving terminal, and has its own coordinator span.

Only allowed fields enter custom structured records. They exclude URLs/queries, signed redirect Locations, authorization/cookies, raw body, arbitrary exception messages and stacks. This protects custom logs; it is not a claim that third-party platform/host logs contain no request data. Generic unknown errors deliberately use `InternalFailure`; locate the last stage/build and reproduce with the local native harness instead of putting unsanitized stacks in public logs. Observability is configured at sampling 1 for this small PoC, with automatic invocation logs disabled. Cloud retention/export and log volume/cost remain deployment decisions. Diagnostics sink failures do not authorize or roll back publication/cache state.

Origin metadata short-cache events distinguish hit, miss, shared lookup and explicit fresh bypass. Inspect `metadataAgeSeconds` and the response `Age`; these do not make cached historical packages current installation authorization. GitHub API response diagnostics safely record numeric remaining quota/reset epoch/retry delay. A rate-limited new/expired lookup cannot fall back to stale approval.

## Read the event chain

| Event/reason | Meaning and next inspection |
| --- | --- |
| `request.rejected` / `RouteNotFound`, `SourceNotAllowed`, `RangeNotSupported` | Rejected before approved origin work; compare configured source and canonical path. |
| `publication.pinned` → `publication.verified` | One publication commit, cross-checked descriptor/hash/length. It does not publish or approve new packages. |
| `origin.identity_verified` / `OriginRepositoryMismatch`, `OriginAssetMembershipMismatch`, `OriginTagMismatch`, `OriginCommitMismatch` | Repository/owner/release/asset/tag proof; inspect approved descriptor or release identity, not an arbitrary URL. |
| `OriginRedirectRejected`, `OriginRedirectLimit` | Redirect host/path/scheme or hop boundary failed; no client fallback. Confirm current GitHub behavior using a controlled asset. |
| `OriginTotalTimeout`, `OriginBodyTimeout`, `OriginRateLimited`, `OriginUnavailable` | See origin attempt/stage/host, duration and GitHub request ID; check configured token/limits without logging credentials. |
| `cache.r2_bypass` / `Miss`, `NotConfigured`, `CoordinatorUnavailable` | Serving continues through Worker origin; a cache failure is not an approval failure or client redirect. |
| `cache.fill_reserved` | SQL committed a lease, bytes and precharged write count; **not an R2 object confirmation**. |
| `cache.fill_committed` / `cache.fill_result: Stored` | R2 put/checksum/size and SQL ready transition confirmed. Requires both; headers or an attempted put are insufficient. |
| `cache.fill_uncertain`, `cache.ledger_commit_unknown`, `CacheLeaseExpired` | Object may exist or late-write. Bytes remain reserved; no duplicate fill or cached hit. See lease and persistent state. |
| `cache.delete_started` → `cache.delete_committed` | Old version bytes are freed only after confirmed R2 delete and SQL transition. Delete-ack or SQL failure leaves `deleting` counted. |
| `cache.paused` / `TrackedObjectMissing`, `StoredObjectMismatch` | Ledger/object drift; cached reads/fills stop. Origin may still serve. |
| `CacheBootstrapRequired`, `CacheBootstrapRejected`, `CacheLedgerPeriodMismatch`, `CacheBudgetExceeded`, `CacheCapacityExceeded` | Explicit bootstrap, period or tracked-budget boundary. Do not clear/reset counters to bypass it. |
| `cache.branch_dropped` | Optional cache writer failed/lagged or client cancelled; use the serving terminal to determine payload outcome. |
| `stream.headers_sent` | Response headers only. HTTP 200 here cannot prove complete bytes. |
| `stream.verified` → worker `request.complete: StreamVerified` | Exact EOF/length and digest proven before final bounded chunk delivery. The client still independently validates the package. |
| `stream.failed`, `stream.cancelled` | Body validation/timeout failure or cancellation. Root terminal 502/499 is the logical result; wire status may already be 200 or be translated by the runtime. |
| `audit.truncated` or missing terminal | Event cap or interruption; neither proves success. Search the coordinator journal and reproduce rather than infer a commit. |

Reservation records now report totals **after** the SQL reservation commits (including object/metadata margin), not the earlier capacity-check snapshot. The 2026-10-04 [live PoC record](docs/history/RepositoryLivePoc.md.txt) binds cold fill, R2 hit and redeploy to actual request IDs. Allow deployment propagation before claiming a new build executed; verify the emitted build field.

## Persistent coordinator journal

SQLite `audit` retains only the latest **256** state/budget records. Its insert/prune occurs in the same SQL transaction as the relevant mutation. After rollback, external logs do not claim a committed transition. `objects` retains `writing`, `uncertain`, `deleting`, `verified` or `ready`; capacity includes unconfirmed states. A recovered `verified` object remains reserved and cannot be evicted. A request can have external logs but no journal row if SQL itself failed, while an earlier reservation still remains durable. This is a bounded troubleshooting journal, not a signed/immutable compliance archive or a replacement for full exported platform logs.

For an already captured **local database copy**, inspect read-only SQL such as:

```sql
SELECT seq, request_id, event, time, value FROM audit ORDER BY seq DESC LIMIT 256;
SELECT key, value FROM objects ORDER BY key;
SELECT value FROM meta WHERE id=1;
```

Use the [account-internal operations tool](ops/README.md) for a bounded inspection/export and explicit confirmation of one expired writing/uncertain object. It uses a local Wrangler remote service binding, not a public SQL/admin endpoint or `wrangler d1` (this is DO SQLite). Inspection performs no R2 operation. Confirmation precharges one Class B GET, validates stored identity/length/checksum and incrementally hashes all bytes, then commits against the captured lease/fingerprint. `cache.recovery_bytes_verified` is not a commit; require `cache.recovery_confirmed`. On failure, look for `cache.operations_rejected`, `cache.recovery_failed` or `cache.recovery_journal_failed`. Read recovery keeps reserved bytes and historical counters; paused ledgers stay paused. A timed-out lease, bucket listing or file absence cannot prove writers finished. Retain the sentinel and never replace the ledger with zeroed metadata. Remote-binding inspection has not passed in the current proxy environment; see the [implementation record](docs/history/CacheRecovery.md.txt).

## Minimal incident record

Record client/gateway IDs, source, snapshot, package/version/digest if present, build ID, approximate UTC time, last relevant events, current object state, used/reserved bytes, Class A/B counters and period. Include whether the client received complete bytes, merely headers, or a truncated/error response. Supply filtered logs and controlled reproduction steps; omit credentials, signed URLs, whole response bodies and account-wide logs.

Local evidence: the regression harness injects lost acknowledgements, SQL/audit failures, late completion, restart, ledger loss, concurrent capacity pressure, timeouts, slow cache and cancellation. Native workerd tests caught and fixed an incorrect global-fetch binding and verify real runtime stream/checksum behavior. These do not prove cloud CPU/billing/retention, mainland connectivity, game HTTP/TLS/proxy behavior or installation recovery.
