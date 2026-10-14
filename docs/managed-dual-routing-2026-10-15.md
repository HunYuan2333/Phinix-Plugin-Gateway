# Managed dual-runtime routing correction

The published schema-3 catalog contains schema-2 managed manifests. Their shared package version lives in `manifest.variants`, while the gateway previously selected packages using `manifest.version` and required schema 1 afterward. A real Example 1.1.2 download against snapshot `ac45d5eb450fb9906e3d7d1b5ce48ed0702919d5` reproduced HTTP 404 `PackageNotFound` before the package asset request.

This differs from the existing limiter failures: `RepositoryRateLimited` returns 429 and `OriginRateLimited` returns 503. The reproduced failure does not establish any GitHub quota problem.

Selection now accepts a validated schema-2 envelope with a shared version and package identity, unique supported game profiles and corresponding target frameworks. The same approved ZIP is streamed unchanged. Existing schema-1 and mod-ZIP routes, digest verification, source identity, limiter, secrets and domain routes remain unchanged.

Validation: 146 unit tests passed; native workerd regression passed (including deliberate bad-stream rejection); production dry-run succeeded. All three actual published managed package records match their expected approved asset identities. Game installation acceptance is separate.

Deployment target: existing `phinix-plugin-repository-staging` service with both public domains. Prior deployed version: `90d4921e-7704-4296-a07a-198046e96a76`, BUILD_ID `gateway-92aea4808c79`. Its binding names and settings were inspected without reading secret values. New BUILD_ID: `production-20261015-managed-dual`. Record final deployed version and live checks after deployment.
