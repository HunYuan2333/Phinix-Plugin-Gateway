# Repository Worker — local P1 prototype

[中文](README.zh-CN.md) · [Audit runbook](AUDIT.md)

This separate Cloudflare Worker serves the client's metadata v1 draft and approved ZIP bytes. It is not part of the dedicated game server or the client DLL. A separate authenticated live PoC was deployed on 2026-10-04; see [live acceptance record](../../../docs/branch-local/dev/plugin-store/RepositoryLivePoc.md). `workers_dev=false`, no route, `R2_ENABLED=false` and `emptyConfirmed=false` are deliberate defaults. The bucket names are configuration placeholders. The official index repository currently has no real published test assets matching this protocol.

## Run locally

Use Node 22.13+ (verified on 26.10.0), npm, and the exact Wrangler/Miniflare versions in the lockfile. These are development dependencies; players need none of them.

```sh
cd Extensions/PluginStore/RepositoryWorker
npm ci --ignore-scripts
npm test
python3 tests/ops-cli.test.py
WRANGLER_LOG_PATH=/tmp/phinix-worker-wrangler-logs WRANGLER_SEND_METRICS=false npm run test:native
```

The final command first bundles with `wrangler deploy --dry-run`, then runs native workerd, SQLite Durable Objects and simulated R2 against a mocked GitHub service. It needs permission to listen on localhost. It uses a temporary state directory, disables Cloudflare property lookup and disposes its runtime. Gateway/operations bundles stay under ignored `.wrangler/dry-run` and `.wrangler/ops-dry-run`. The harness also exercises the local bridge, named WorkerEntrypoint and DO RPC, and an isolated lost-ack R2 fixture. This local command does not deploy. Platform binary packages installed by npm worked without postinstall scripts in this environment; other platforms must verify their toolchain independently. Miniflare 5 currently comes from Wrangler's pinned alpha dependency and the harness uses its v4 option converter.

`npm test` executes the actual individual cases with `--test-isolation=none`: routing/JSON/identity/hash, SQL fault injection, concurrent fill, ambiguous write/delete acknowledgements, restart, lease and budget boundaries, timeouts, slow branches, cancellation and log filtering. The SQLite adapter uses a real local SQLite database with injected faults; it is not a Cloudflare deployment. Native tests exercise binding behavior, known-length R2 streams, checksum enforcement, cold fill, hit without author origin, and corrupt-byte rejection. Package fixtures are synthetic bytes; ZIP/PE validation is exercised by the existing C# harness, not by this gateway.

## Serving contract

Only canonical `GET`/`HEAD` paths, without queries, encoded segments or `Range`, are accepted:

- `/v1/sources/{source}/stable`
- `/v1/sources/{source}/snapshots/{snapshot}/published/{sha256}`
- `/v1/sources/{source}/snapshots/{snapshot}/catalog/{sha256}`
- `/v1/sources/{source}/snapshots/{snapshot}/packages/{id}/{version}/{sha256}/package`

Sources come from the configured allowlist. Each request verifies the configured public repository and owner IDs, pins the publication branch to one commit, and reads publication records at that commit. Catalog bytes bind to one index Release asset; package bytes bind to the catalog's repository/owner/release/asset IDs, exact tag/source commit, name, length and SHA-256. The adapter follows bounded binary redirects only to the fixed GitHub release-asset CDN path and never forwards its GitHub token there. The client receives no external `Location`. No arbitrary URL proxy, manifest endpoint, Steam download, publisher approval, or ZIP extraction is implemented. The publisher/client must still perform full schema, dependency and payload validation.

Metadata has strong hash ETags. A metadata cache may replay the request ID of the response producer; use the client refresh ID to locate newly executed requests. HEAD/304 establish approved snapshot metadata, not payload delivery or permission to install. Historical published snapshots can remain downloadable; a later installer must recheck current approval before confirmation/commit.

Package responses are `no-store`; edge caching remains disabled pending deployed stream/Range/CPU tests. Both origin and R2 body streams verify exact length and incremental SHA-256. The last bounded chunk is held until upstream EOF and digest succeed, preventing complete corrupt payload delivery to Content-Length clients. HTTP headers can already be 200 when a stream later fails. Count `stream.verified` as byte verification, not `stream.headers_sent`, and require independent client verification. A runtime can translate an early stream error into HTTP 500 or terminate/truncate the response.

Origin work is limited to 24 calls and a 20-second origin budget, with 6-second fetch/body idle timeouts. Payload streaming has a separate 30-second total and 6-second idle limit. Each input chunk is capped at 1 MiB. R2 uses a known-length `FixedLengthStream`; an optional branch may delay serving at most 200 ms per write/close before being aborted. No tee, response clone or complete payload buffer is used. These are prototype limits and need real package/network validation; the client's existing ten-second metadata watchdog is separate.

## Private R2 coordination

One SQLite Durable Object owns one private, dedicated bucket and tracks at most 256 objects. The cache key includes source/package/version/digest. A cold ledger requires explicit empty-bucket confirmation, precharges a list plus sentinel put, and stops if any object already exists. The persistent sentinel detects ledger loss even after all packages have been evicted. Interrupted bootstrap stays closed.

Capacity includes a 4 KiB baseline and 2 KiB per-object allowance. The checked-in prototype uses 64 MiB and permits fills up to 8 MiB; bigger approved packages may stream without filling. Reservations and Class A/B counters are persisted before calls. SQL state transitions and the bounded audit journal commit together; external “committed” events are emitted only after a transaction returns. R2 and SQL are separate transactions. Missing acknowledgements, expired leases or failed SQL commits retain reserved bytes and block duplicate fills. A confirmed old-version deletion is required before freeing bytes. Missing/mismatched tracked objects pause caching. Reads/fills stop when configured budgets or period bounds are reached. Worker origin serving can continue when cache operations fail.

There is no automatic uncertain-object repair, period reset, ledger rebuilding from current bucket size, public administration API, or purge endpoint. The [internal operations tool](ops/README.md) inspects/exports the journal and restores reads after full object verification, while retaining uncertain capacity reservations. It does not prove late writers quiescent or resume a paused ledger. Do not clear the ledger, remove the sentinel, share the bucket with other writers, or reuse `emptyConfirmed` to reset historic operation counts. This conservatively bounds the tracked prototype; it does not establish an account-wide zero-cost guarantee or a deployed 9 GB hard-cap proof.

## Before public integration

Prepare a controlled real test Release/catalog and immutable published record, then configure the account, test route, new private bucket, SQLite binding, period/budgets and build ID. Keep credentials in Wrangler secrets or ignored local vars, using an optional read-only `GITHUB_TOKEN` only for the Worker origin adapter. Verify CDN redirects, identity withdrawal/mutation, cold reconstruction, operation/capacity boundaries, disconnect/slow-client behavior, logging retention and cloud CPU/billing limits. Add edge caching only after those tests. Current code is unsigned and trusts configured endpoint TLS/source configuration; it supplies no new approval database.

## Controlled live configuration

`wrangler.poc.jsonc` explicitly names the isolated PoC resources; the default config remains disabled. `POC_MODE=true` requires a newly generated `POC_ACCESS_TOKEN` secret and rejects all requests after `POC_EXPIRES_AT`, before origin/cache operations. PoC metadata and package responses use `no-store`. The temporary gate is for CLI testing; the game transport does not currently send this token. Do not paste this endpoint into the game and expect it to work. Secret values and platform tail captures stay outside Git.

The separate bucket starts with a 64 KiB tracked capacity, Class A/B budgets of 100 each and a fixed 48-hour period. Preserve epoch/period/counters when redeploying; expiry closes serving, it does not delete resources or reset history. Use standard Wrangler authentication, never extract its OAuth config or forward the personal `gh` login token to the Worker.

Explicit live probes: `tests/live-poc.py --endpoint <https-endpoint> --directory <private-fixture-directory>` (use `python3`) checks fixed bytes and protocol responses; `--after-redeploy` appends a single read. Run `tests/live-audit.py --directory <directory>` on a private Wrangler tail capture to extract only allowlisted custom records and assert request/span correlation, verified streams, committed cold fill and warm hits. These probes are not run by `npm test`; a repeated cold probe requires genuinely new isolated state, not clearing the existing ledger.

### Bounded origin metadata cache

`ORIGIN_METADATA_CACHE_SECONDS` defaults to `0` (off); the isolated live PoC opts into `30`. Values above 300 fail closed. The per-isolate disposable LRU holds at most 64 entries/2 MiB, each at most 64 KiB, and tracks at most 16 concurrent lookups. It caches successful bounded API metadata and fully hash/size-validated catalog bytes only. Payload/redirect streams, failed requests and expired entries are never served from this cache. Credential scopes are hashed into keys, never logged. All ordinary parsing/identity/hash checks still execute after a hit.

Within the TTL, a warm verified catalog plus R2 hit needs no GitHub call. A cold isolate or expired approval still requires GitHub; this reduces pressure, not an anonymous-limit or availability guarantee. `Cache-Control: no-cache` bypasses both cache and in-flight joins for a fresh lookup. Metadata responses expose conservative `Age` from lookup start, and log `origin.metadata_hit/miss/join/bypass`, plus bounded age on a hit. The future confirmation/commit flow must check freshness or explicitly request a fresh chain; a cached historic package is not current install authorization. This is not Cloudflare edge caching, persistent approval or stale-on-error.

References: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [GitHub release assets](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28), [Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/).

## Custom-domain PoC follow-up

The authorized isolated PoC now also binds `https://plugins.hunyuan2333.com`; its access token was rotated after the local copy was lost, while expiry/resources/accounting were preserved. Direct TLS/DNS and one byte-exact stable read passed. Published/full-chain acceptance stopped on GitHub anonymous HTTP 403 with zero remaining origin quota, including one bounded repeat; no real-domain ZIP success is claimed. At that stage, a dedicated read-only `GITHUB_TOKEN` Worker secret was the next dependency; the later successful run is recorded below. `tests/live-poc.py --direct --existing-cache` disables endpoint proxies, rejects redirects and labels the existing-cache test; it requires private fixtures and the PoC access secret. See [direct acceptance record](../../../docs/branch-local/dev/plugin-store/CustomDomainDirectAccess.md).

The operator has now uploaded the dedicated origin secret. The repeat passed all nine no-proxy metadata/ZIP protocol checks and 151 filtered audit records; both 4179-byte ZIP reads matched expected bytes and hit R2. The earlier anonymous-limit failures remain in the record. The game transport does not send the temporary PoC gate token; game-accessible staging, game networking, multi-network reliability, large payloads and production budgets remain pending.

## Public game staging

`wrangler.staging.jsonc` deploys an independent anonymous read-only source at `https://plugins-staging.hunyuan2333.com`, requiring its own origin secret and local aggregate limiter before GitHub access. It has no R2/DO/operations exports or PoC expiry; metadata is no-store. The response framing fix preserves native Content-Length and keeps strict client length/digest checks. Nine public protocol checks, 117 Worker tests, native regression and actual net472/Mono download/static validation passed; game and production acceptance remain pending. See [staging record](../../../docs/branch-local/dev/plugin-store/GameStaging.md).


### Production read-only gateway (2026-10-06)

Deploy `wrangler.production.jsonc` at `https://plugins.hunyuan2333.com`. Reuse the existing Worker service and GITHUB_TOKEN; the former staging address is a temporary alias of that same service. `wrangler.staging.jsonc` matches production to prevent an old command removing the official domain. The entry is `src/read-only.mjs` / REPOSITORY_ENABLED with fixed phinix.official, aggregate limiting and no R2/DO/public operations. Historical PoC config has public routes disabled and is not production distribution. [Migration, rollback, checks and pending retirement approval](../../../docs/branch-local/dev/plugin-store/ProductionCfMigration.md).
