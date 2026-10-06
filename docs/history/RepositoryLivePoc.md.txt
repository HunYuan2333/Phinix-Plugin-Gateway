# Live distribution PoC — 2026-10-04

[中文](真实分发链路PoC.md) · [Worker](../../../../Extensions/PluginStore/RepositoryWorker/README.md)

A controlled small-package GitHub → Worker → private R2/SQLite chain passed, then continued probing exposed anonymous GitHub API rate limiting. This is a real deployment record, not production or in-game acceptance. Standard gh/git/Wrangler were used; no Computer Use or plan upgrade.

## Isolated identities

Repository [HunYuan2333/Phinix-PluginStore-PoC](https://github.com/HunYuan2333/Phinix-PluginStore-PoC), source `phinix.poc`, repository ID `1403380030`, owner ID `64630568`. Source/input snapshot `e3c57856b3a68c1d25e18dbe2b4f90e4e8618779` contains original MIT inert net472 code without initializers, game hooks, network or storage behavior. Templates: `repository-poc-v1/source/`. No host license is inferred.

Package [v1.0.0](https://github.com/HunYuan2333/Phinix-PluginStore-PoC/releases/tag/v1.0.0): Release `402587444`, asset `608105641`, 4179 bytes, SHA-256 `0299999c8d6b14f7759e5d5dd06ce922aa520ef08e74bfc2540898cea68cfb11`; exact tag resolves to the source commit. ZIP contains only About, manifest and original assembly. Catalog [catalog-e3c5785](https://github.com/HunYuan2333/Phinix-PluginStore-PoC/releases/tag/catalog-e3c5785): Release `402587655`, asset `608106430`, 1047 bytes, SHA-256 `a878ea6cff79f3621006f92433cdca6874bde1397032e71acbb1d40a3dd30e7f`. Immutable descriptor commit `911956f` was pushed before stable commit `c85c5f2`.

Worker `phinix-plugin-repository-poc`, private Standard/APAC bucket `phinix-plugin-poc-20261004`, SQLite CacheCoordinator; separate `wrangler.poc.jsonc`. Default config remains disabled. Endpoint `https://phinix-plugin-repository-poc.zydyouxiang.workers.dev` requires a newly generated PoC-only Bearer secret. Expiry **2026-10-05T16:10:49.973000+00:00**, then serving rejects with 410; resources/history remain. Secret is in a private temporary file, not Git. No personal gh or Wrangler OAuth token was extracted or uploaded. The game transport does not send this temporary token.

Epoch `poc-20261004-v1`, period `poc-20261004`, 64 KiB tracked capacity including margins, A/B budgets 100 each, max fill 64 KiB. Preserve epoch, period and counters across redeploys. Edge caching and shared PoC metadata caching are off (`no-store`). Formal index HEAD remains `008777cf228d709a952aa3c3d71565fdf849fdbf`; only the separate test repository was pushed.

## Evidence and observed failure

All metadata matched validated bytes. Cold and warm downloads and a direct private `wrangler r2 object get --remote` read matched the frozen package hash. The operator read is one additional Class B operation outside service-ledger counters. Cold logs correlate bootstrap A=2, miss, reservation A=3, verified stream, SQL fill commit and fill-result 201. Final totals: used=10323, reserved=0, rows=1. Warm logs show R2 hit, A=3/B=1, no package asset origin fetch/fill; approval metadata still requires GitHub. An early post-redeploy read executed the old propagated build and retained A=3/B=2 without bootstrap or duplicate put; it does not prove new code execution.

A subsequent request executed audit fix build `poc-20261004-b190f51a1e5b`, then GitHub 403 became correlated `OriginRateLimited` 503 before cached delivery. R2 alone does not avoid online approval lookup limits. Do not bypass approval or export the broad personal gh token; add appropriately scoped repository-read credentials and bounded metadata query/cache behavior while retaining install freshness rules.

Reservation audit now reports post-SQL-reservation totals, with a regression checking both emitted and persistent records before put. Added safe numeric `rateLimitRemaining`, Unix-second `rateLimitReset`, `retryAfterSeconds` from trusted GitHub API headers only; arbitrary strings and out-of-range values are discarded. Latest source concatenation digest `a10d014408e640fad44fded743ce74cb8f70b3fd5594b892dc0ed983772b6b46`, build `poc-20261004-a10d014408e6` (not a root Git commit), deployed after local/native validation; not claimed to resolve rate limiting.

Only non-sensitive acceptance summaries follow. Private raw platform tail may contain request data; never commit it. Filtered probes assert correlation, one root terminal and cold/warm outcomes, including the later failure.

| Probe | HTTP | Bytes | Gateway request ID | Executed build |
| --- | --- | --- | --- | --- |
| unauthenticated | 401 | 95 | `eeff230c-9715-4a91-ad0a-ef3496245fd3` | poc-20261004-dd605aab1449 |
| stable | 200 | 342 | `5d6d5207-bc75-4451-84b1-8fe071d7a0f3` | poc-20261004-dd605aab1449 |
| published | 200 | 404 | `a96dee6b-f266-44a9-87ed-7b3a1e905375` | poc-20261004-dd605aab1449 |
| catalog | 200 | 1047 | `c7d46b28-7211-46a4-9931-1e4d0d2bb1b3` | poc-20261004-dd605aab1449 |
| package-cold | 200 | 4179 | `d5ae962d-3d05-40a9-adfd-759a4a1ff387` | poc-20261004-dd605aab1449 |
| package-warm | 200 | 4179 | `88dabd7e-ca1d-410a-a1de-bddad06264f1` | poc-20261004-dd605aab1449 |
| stable-not-modified | 304 | 0 | `bc5fe3eb-dce8-4b2b-8a93-e54c8391a7b9` | poc-20261004-dd605aab1449 |
| range-rejected | 416 | 97 | `8b543490-f8b4-44b8-b568-2c9db072c519` | poc-20261004-dd605aab1449 |
| query-rejected | 400 | 91 | `9f2b8a70-f31b-44ed-9ce7-e9d7a845cce3` | poc-20261004-dd605aab1449 |
| package-after-redeploy-initial | 200 | 4179 | `d8848653-0cbf-4da8-922d-70446db010c0` | poc-20261004-dd605aab1449 |
| package-after-redeploy-limited | 503 | 96 | `c704ae07-27df-4342-ae59-0d7e7b86175c` | poc-20261004-b190f51a1e5b |

```sh
npm --prefix Extensions/PluginStore/RepositoryWorker test
WRANGLER_LOG_PATH=/tmp/phinix-worker-wrangler-logs WRANGLER_SEND_METRICS=false npm --prefix Extensions/PluginStore/RepositoryWorker run test:native
dotnet run --project Tests/PluginStoreRuntimeTests/PluginStoreRuntimeTests.csproj --configuration Release -p:BuildInParallel=false -m:1 --no-restore
dotnet build Tests/PluginStorePayloadCheck/PluginStorePayloadCheck.csproj --configuration Release --no-restore -p:BuildInParallel=false -m:1
dotnet run --project Tests/PluginStorePayloadCheck/PluginStorePayloadCheck.csproj --configuration Release --no-build -- phinix.poc /tmp/phinix-live-poc/catalog.json /tmp/phinix-live-poc/phinix-poc-marker-1.0.0.zip /tmp/phinix-live-poc/metadata/stable.json /tmp/phinix-live-poc/metadata/published/e3c57856b3a68c1d25e18dbe2b4f90e4e8618779.json
python3 Extensions/PluginStore/RepositoryWorker/tests/live-poc.py --endpoint https://phinix-plugin-repository-poc.zydyouxiang.workers.dev --directory /tmp/phinix-live-poc --after-redeploy
python3 Extensions/PluginStore/RepositoryWorker/tests/live-audit.py --directory /tmp/phinix-live-poc
```

## Validation and remaining work

Worker **69/69**, native workerd/SQLite/simulated R2, client **429 assertions**, real production parser/static ZIP/PE checking passed. Initial nine live protocol/byte probes passed; later new-build package probe failed under real anonymous-origin limits and was retained as a failed result. Filtered audit assertions passed. Payload checker build: zero errors, NU1900 network warning fetching vulnerability metadata; no untrusted DLL executes. Prior full client packaging validation was not repeated this batch; no game validation.

An initial Python default User-Agent received a non-JSON 403 without gateway ID; curl-style User-Agent reached application 401/200 on the existing proxy. This is one proxy network, not evidence of game TLS or mainland access. Remaining P1: scoped credentials/rate pressure, controlled uncertain-object reconciliation, large payload/CPU/disconnect/billing/retention, edge cache and mainland observations. P2 needs game HTTP/TLS/proxy integration; P3 needs bounded file downloads. Formal approval, signatures, installation and recovery remain unfinished. No trade protocol, item ownership or save migration changes. Expiry rejects requests but does not remove resources or stop retained-storage charges.

## Continued implementation: reducing metadata queries

Added a bounded per-isolate raw metadata LRU and same-key lookup coalescing, enabled for 30 seconds in the isolated PoC; default remains off. Limits: 64 entries/2 MiB, 64 KiB each, 16 tracked in-flight lookups. Catalog enters only after complete validation; hits still pass schema/identity/hash checks, with credential-scope isolation. No errors, expired fallback or payload buffering. Response Age starts at lookup start. `Cache-Control: no-cache` bypasses both stored and shared lookups for future confirmation/commit freshness.

Worker **77/77** and native workerd/SQLite/R2 passed, including warm metadata + R2 with zero GitHub calls, coalescing, immutable byte copies, capacity/entry/in-flight limits, expiry failure, slow-expired fill, credential isolation and fresh bypass. Latest build `poc-20261004-0be077832501`, source digest `0be077832501dd863e6b1865da8b22aac361b7b2b27da0de10d769955252bb66`; test deployment preserves ledger epoch/period/counters. Post-deploy public cache benefit awaits anonymous-limit reset/retest; cold isolates still need scoped read credentials. Local zero-origin proof does not establish resolved public limits.

Latest cache build deployed successfully through standard Wrangler; Cloudflare version ID `23ca722a-ea3b-4b95-aec7-231b4f1c91fb`. Exact checks: `npm --prefix Extensions/PluginStore/RepositoryWorker test`; `WRANGLER_LOG_PATH=/tmp/phinix-worker-wrangler-logs WRANGLER_SEND_METRICS=false npm --prefix Extensions/PluginStore/RepositoryWorker run test:native`. Both exited successfully.

## Internal read recovery follow-up

The next batch added internal inspection/export and verification-based read recovery that retains all capacity reservations. See [CacheRecovery](CacheRecovery.md) for 101 regression cases, native lost-ack evidence and deployed build/version. Live operations RPC timed out; it is not recorded as a passed cloud inspection.
