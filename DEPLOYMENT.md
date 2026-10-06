# Deployment ownership

[中文](DEPLOYMENT.zh-CN.md).

This repository targets the existing `phinix-plugin-repository-staging` service. Its name is an infrastructure identifier: both `plugins.hunyuan2333.com` and the transitional `plugins-staging.hunyuan2333.com` route to the same production service. Preserve both routes during source migration.

The validation workflow is read-only and contains no deployment credential. It builds and tests production and isolated historical cache/operations fixtures; no cloud resources are created. A passed workflow is not a deployed version or game acceptance.

The operator uses the existing Wrangler login locally. The service already holds its read-only `GITHUB_TOKEN`; source migration does not require reading/copying its value. Never place account credentials, `.dev.vars`, logs or operations backups in source.

After reviewing the exact committed source, checking tests and verifying the current version/routes/bindings, deploy from this checkout only:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
WRANGLER_SEND_METRICS=false npm run test:native
WRANGLER_SEND_METRICS=false npm run check:production
# Only the maintainer's production deployment uses cloud credentials.
WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy -c wrangler.production.jsonc
```

Record source commit, bundle/configuration hashes, Worker version and BUILD_ID for every deployment. Set the same unique BUILD_ID in production/transitional configuration together before committing a release. Do not deploy from `wrangler.jsonc`, `wrangler.poc.jsonc` or `wrangler.ops.jsonc`; they exist for historical tests/internal operations. Production has no R2/DO/admin binding. Keep the limiter namespace and source identity unchanged.

Before switching ownership, capture a previously verified production version. If acceptance fails, use `wrangler rollback <VERIFIED_VERSION_ID> -c wrangler.production.jsonc` and verify service routes, binding names and real downloads again. Rollback is an operator action, not an automatically tested cloud guarantee, and does not restore destroyed state.

Postflight compares GitHub/CF stable, published, catalog and ZIP against one fixed snapshot, checks digests/lengths/304 and negative routes, and matches audit request IDs/build. Run actual client .NET/Mono download checks from a fixed client source checkout separately. Human acceptance: CF refresh, switch to GitHub, retained installed Example/settings. No downloaded plugin is executed by the gateway checks.

Old PoC public access is disabled, but permanent Worker/R2/DO/secret removal is separate and remains unapproved. Never delete it as part of adopting this repository. Once the new entry point is accepted, stop deploying from the main repository before removing its source. Do not let both copies compete for production configuration.

CI-based cloud deployment is not enabled here. If added later, scope a separate CF deployment credential, protect production execution and restrict it to reviewed source; author Issues and external PRs must never deploy this service.
