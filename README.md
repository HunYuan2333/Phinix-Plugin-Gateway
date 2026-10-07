# Phinix Plugin Gateway

<p align="center">
  English · <a href="./README.zh-CN.md">简体中文</a>
</p>

The official Cloudflare access adapter for the Phinix plugin distribution infrastructure.

---

## Architecture & Responsibilities

- **Authoritative Source**: [Phinix-Plugin-Index](https://github.com/HunYuan2333/Phinix-Plugin-Index) remains the authoritative catalog and release asset source on GitHub.
- **Gateway Adapter**: Cloudflare Worker validates requested paths, enforces rate limits, caches metadata responses, and transparently streams release assets from upstream GitHub origins.
- **Dual Client Routes**: Players choose between **GitHub Direct** and **CF Acceleration** in the game client settings. Both routes return identical protocols, metadata schemas, and byte-for-byte asset payloads.

> [!NOTE]
> The gateway is a read-only distribution proxy. It does **not** process uploads, execute plugin code, manage game servers, or store game state.

---

## Public Endpoints & Status

- **Primary Production Domain**: `https://plugins.hunyuan2333.com`
- **Legacy Staging Alias**: `https://plugins-staging.hunyuan2333.com` (routes to the same worker service)
- **Official Catalog Route**: `/v1/sources/phinix.official/stable`
- **Asset Proxy Route**: `/v1/sources/phinix.official/assets/...`

---

## Runtime Configuration & Limits

Production runs `src/read-only.mjs` configured by `wrangler.production.jsonc`:

| Setting | Value / Policy | Description |
| :--- | :--- | :--- |
| **Worker Service** | `phinix-plugin-repository-staging` | Shared Cloudflare service name |
| **Request Limiter** | 30 requests / 60 seconds | Enforces per-IP burst protection via `REQUEST_LIMITER` |
| **Metadata Cache** | 30 seconds TTL | Edge caching for origin catalog pointers |
| **Storage Bindings** | None (`R2_ENABLED: false`) | R2 and Durable Objects are disabled in production |
| **Origin Token** | Read-only GitHub Token | Injected via Cloudflare Worker secrets for GitHub API access |

> [!IMPORTANT]
> The repository includes `wrangler.poc.jsonc` and `wrangler.ops.jsonc` strictly for historical testing and isolated maintenance. They must **not** be deployed to production.

---

## Local Verification

Use Node.js (via npm) and Python 3. Tests run against local mock origins and synthetic fixtures without requiring live Cloudflare or GitHub credentials:

```bash
# Install pinned dependencies
npm ci --ignore-scripts --no-audit --no-fund

# Run unit tests and mock worker suite
npm test

# Run CLI and operations tests
python3 tests/ops-cli.test.py
python3 tests/network-check.test.py
python3 tests/live-probe.test.py

# Run local native worker execution check
WRANGLER_SEND_METRICS=false npm run test:native
```

Protocol fixtures are pinned and self-contained under [`tests/fixtures/`](tests/fixtures/README.md). Continuous Integration (`check.yml`) executes verification only and does not trigger deployments.

---

## Operations & Rollback

- **Deployment Guide**: [`DEPLOYMENT.md`](DEPLOYMENT.md) — Step-by-step production deployment commands and build auditing.
- **Audit & Diagnostics**: [`AUDIT.md`](AUDIT.md) — Request ID correlation, error codes, and origin fault isolation.
- **Rollback Procedure**: In case of routing or proxy regressions, maintainers execute `wrangler rollback <VERSION_ID> -c wrangler.production.jsonc` to revert to a previously verified worker deployment.
