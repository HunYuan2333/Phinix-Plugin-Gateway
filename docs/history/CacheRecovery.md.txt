# Cache inspection and read recovery implementation

Date: 2026-10-04. Branch: `dev`. [中文](缓存受控核对与读取恢复.md). This adds account-internal operational tooling to the isolated repository PoC. It does not modify client/framework APIs, trade state, item ownership, the formal index or package approval.

## Delivered behavior

`RepositoryOperations` is a named WorkerEntrypoint bound to the existing singleton SQLite DO. [The local CLI/runbook](../../../../Extensions/PluginStore/RepositoryWorker/ops/README.md) uses standard Wrangler authentication, a loopback-only bridge and strict bounded JSON; the public gateway has no operations route. The PoC opts into `CACHE_OPERATIONS_ENABLED`; the default remains off. Inspection exports one SQL snapshot with object fingerprints and the latest 64 journal records, with no R2 calls. The Python exporter uses a new 0600 file, not an overwrite.

Explicit confirmation accepts only an expired writing/uncertain object matching the captured identity/lease/fingerprint, with no active write. A SQL transaction reserves one Class B GET before access. Stored metadata/length/checksum and an incremental full-body SHA-256 must all pass, then SQL compare-and-set commits `verified`. It remains reserved/non-evictable and cannot be filled again. A paused ledger stays paused. Lookup/body/hash timeouts, bounds, concurrent requests, changed snapshots, missing/corrupt bytes, budget exhaustion and SQL faults leave the original reservation and counters intact. No capacity release, arbitrary SQL, delete/purge, reset, period rollover or bootstrap repair is provided.

`cache.recovery_bytes_verified` reports bytes only; `cache.recovery_confirmed` is emitted after SQL commit. The persistent journal and external request/lease/period logs correlate failures. Unfiltered exception strings, URLs and credentials are excluded from custom logs. The native harness caught an RPC serialization issue: strict JSON uses null-prototype maps, so the bridge converts validated input to ordinary serializable objects before RPC.

## Exact validation and deployment

From `Extensions/PluginStore/RepositoryWorker`:

```sh
npm test
python3 tests/ops-cli.test.py
WRANGLER_LOG_PATH=/tmp/phinix-worker-wrangler-logs WRANGLER_SEND_METRICS=false timeout 45s npm run test:native
```

All three returned exit 0. Four operator CLI integration tests additionally exercised exclusive 0600 exports, plan-only behavior without a network call, fixed-identity apply, oversized/mismatched snapshots and refusal of external targets through a local HTTP stub. They do not exercise cloud authentication. The regression suite passed **101 cases** (77 previous plus 24 recovery cases). The complete native pipeline dry-ran both bundles, then tested real workerd, SQLite DO, R2, local bridge → named WorkerEntrypoint → DO inspection, and an actual native R2 put followed by injected lost acknowledgement → expired lease → verified read. Recovery left capacity totals unchanged. Native fault injection uses a separate local bucket and is absent from every deployment config. Expected corrupt-stream faults produce runtime diagnostics; the harness asserts rejection and exits successfully.

Using standard `wrangler deploy -c wrangler.poc.jsonc --secrets-file <private-file> --autoconfig=false` deployed build `poc-20261004-d1e140659fae`, source SHA-256 `d1e140659fae6cc084b4d699251425a228672dd3e17309a2ef63e296c7095bd3`, version `d83b7712-c32b-4c89-adf1-3a8ba55b4dbc`. Epoch `poc-20261004-v1`, period `poc-20261004`, resources and budgets were preserved. There was no live R2 fault injection or confirmation.

Initial cloud inspection **had not passed**. Standard `wrangler dev -c wrangler.ops.jsonc` established a remote service connection and a loopback listener; invalid local actions returned a correlated 400. The read-only Python inspection timed out. A wrong-epoch RPC also timed out; the temporary tail captured no target operations event. Remote preview was tried without weakening bridge guards, and the HTTP request also timed out. Explicit loopback proxy exclusions were tested. These observations do not establish a root cause or prove the deployed entrypoint executed. Temporary processes were stopped and no ledger reset/deletion was used. Raw logs/secrets/attempt records remain under `/tmp`, outside Git. The normal PoC serving expiry is unchanged; expiry does not delete its bucket or counters.

## Live inspection accepted

At 2026-10-04 10:41 Singapore time, the user reported a successful read-only inspection after the TUN retry. The exported JSON was also read locally: `ok=true`, Worker request ID `652c4e89-ae9b-47d8-8dd3-cf3f0fdc9673`, status `ready`, Class A/B 3/2, used/reserved bytes 10323/0 and one ready object. The loopback bridge returned HTTP 200 in 692 ms with its separate request ID `8318a703-fb16-4ff1-b7c6-69ffa4063795`; those IDs are separate trace scopes. No live confirmation or capacity change was executed. This accepts cloud inspection on that operational network path, not player access. See [custom-domain direct tests](CustomDomainDirectAccess.md) for the later proxy-free public endpoint comparison.

## Remaining acceptance

Cloud read-only inspection is accepted; isolate live recovery faults separately from the existing bucket if needed. Late-writer quiescence and safe capacity release remain a distinct design/validation task; a missing object is insufficient evidence. Cloud CPU, large payloads, disconnections, account budgets, edge caching, mainland connectivity, scoped origin credentials and actual Unity/Mono networking remain pending. No C# test, client build or in-game validation was rerun in this batch. Next client work is bounded ZIP download to a controlled temporary file and integration with the existing static validator; file installation/recovery comes later.
