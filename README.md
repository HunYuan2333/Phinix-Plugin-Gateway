# Phinix Plugin Gateway

[中文](README.zh-CN.md) · [Deployment](DEPLOYMENT.md) · [Audit](AUDIT.md)

The official Cloudflare access adapter for the Phinix plugin store. GitHub remains the authoritative catalog and package source; the gateway checks identity, lengths and digests while serving the same protocol and bytes. Players can choose GitHub directly or CF acceleration in the client.

Production uses `src/read-only.mjs` and `wrangler.production.jsonc`. Its existing service serves `https://plugins.hunyuan2333.com` and temporarily retains the former staging domain as an alias. It has no R2, Durable Object or public operations binding. The gateway is independent of Mod releases and the multiplayer server.

## Local validation

Use the locked Node/Wrangler/Miniflare toolchain and Python 3. Tests use mock origins and local runtime resources, without GitHub/Cloudflare credentials or RimWorld assemblies.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
python3 tests/ops-cli.test.py
python3 tests/network-check.test.py
python3 tests/live-probe.test.py
WRANGLER_SEND_METRICS=false npm run test:native
```

Native/operations tests need temporary localhost listeners. Shared protocol fixtures are self-contained and pinned in [tests/fixtures](tests/fixtures/README.md). CI only validates; it does not deploy. See the deployment guide for the explicit production configuration, audit evidence and rollback checks.

`wrangler.jsonc`, `wrangler.poc.jsonc`, `wrangler.ops.jsonc` and cache code are retained for historical/isolated tests and internal maintenance, not ordinary production deployment. Old PoC resource deletion is outside source migration. The original prototype notes are preserved as text in `docs/history/`.

Source originated in the reviewed, untracked Worker working tree of Phinix-Rework. `migration-manifest.json` records the imported bytes and subsequent migration edits. Production implementation and configuration are preserved; tests no longer read outside this repository. No new license grant is introduced by migration; the source repository has no root license file to carry over.
