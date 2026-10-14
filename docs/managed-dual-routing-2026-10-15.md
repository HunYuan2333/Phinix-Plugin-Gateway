# Managed dual-runtime routing correction

The published schema-3 catalog contains schema-2 managed manifests. Their shared package version lives in `manifest.variants`, while the gateway previously selected packages using `manifest.version` and required schema 1 afterward. A real Example 1.1.2 download against snapshot `ac45d5eb450fb9906e3d7d1b5ce48ed0702919d5` reproduced HTTP 404 `PackageNotFound` before the package asset request.

This differs from the existing limiter failures: `RepositoryRateLimited` returns 429 and `OriginRateLimited` returns 503. The reproduced failure does not establish any GitHub quota problem.

Selection now accepts a validated schema-2 envelope with a shared version and package identity, unique supported game profiles and corresponding target frameworks. The same approved ZIP is streamed unchanged. Existing schema-1 and mod-ZIP routes, digest verification, source identity, limiter, secrets and domain routes remain unchanged.

Validation: 146 unit tests passed; native workerd regression passed (including deliberate bad-stream rejection); production dry-run succeeded. All three actual published managed package records match their expected approved asset identities. Game installation acceptance is separate.

Deployment target: existing `phinix-plugin-repository-staging` service with both public domains. Prior deployed version: `90d4921e-7704-4296-a07a-198046e96a76`, BUILD_ID `gateway-92aea4808c79`. Its binding names and settings were inspected without reading secret values. New BUILD_ID: `production-20261015-managed-dual`. Record final deployed version and live checks after deployment.

## Deployed result

- Source commit: `f02cf7ba9ce31f48dee64a302fe4f523e346732b`.
- Worker version: `6e8e0280-6a21-437b-9f4e-ada8bb64758d`.
- Production bundle SHA256: `4f456f16973282cb2b8d9d07f7e652b8a849e40bd2cd83c5d71bb199b5fa8767`.
- Production configuration SHA256: `6d9f9318774095a33c503320f5a28c4bc2e75f3f4a0093332529060646910219`.
- Live stable/published/catalog checks matched snapshot `ac45d5eb450fb9906e3d7d1b5ce48ed0702919d5` and catalog SHA256 `2589057d99cbcdec727e423fb5e06e98715c5a6744521994df3095977117fef5`; both domains returned stable metadata successfully.
- Real RedPacket 1.2.6, TalentTrade 1.2.3 and Example 1.1.2 downloads returned HTTP 200 with exact approved ZIP lengths and SHA256 values. Conditional requests returned 304; nonexistent versions returned 404.
- Example successful live request ID: `89127cb6-1e93-48fc-9fd3-e3461757db9e`. The originally reported request ID was not retrieved from server logs; diagnosis is supported by independent reproduction and source analysis.

These checks establish gateway delivery, not RimWorld installation or plugin gameplay acceptance.
