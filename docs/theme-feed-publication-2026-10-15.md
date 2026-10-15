# Theme feed publication and package credential isolation

## Published state

The independent `phinix.themes` feed uses schema 4 and the `themes` publication branch of `HunYuan2333/Phinix-Plugin-Index` (repository 1402564805, owner 64630568). Index source commit `d7f00d50da829f1b022059d6573e43cf67a3d28b` published successfully in run 38679716960. Its snapshot is that source commit and its catalog SHA256 is `ea31fda62db704bb204a0676a94df92711bb30d2d417ee013ed0c884bf2a4828`.

Public theme sources and immutable v1.0.0 releases:

| Package | Repository | ZIP SHA256 |
| --- | --- | --- |
| phinix.theme.tokyo-night | https://github.com/Phinix-Rework-Themes/Tokyo-Night | 877396e014536af73f0e0b284b818a9706f4f018fdcd433133547a2f41339de7 |
| phinix.theme.daylight | https://github.com/Phinix-Rework-Themes/Daylight | 8d5bcbaf36c50fbb57f77c764aa309e68ddde6866218a5809c1f7aac4d65c3be |

Both are data-only packages requiring main mod >=0.10.3 <1.0.0. Installation does not apply a theme. Each package supports both game versions through the shared XML format.

The existing `phinix.official` plugin pointer remained unchanged: snapshot `ac45d5eb450fb9906e3d7d1b5ce48ed0702919d5`, schema 3, catalog SHA256 `2589057d99cbcdec727e423fb5e06e98715c5a6744521994df3095977117fef5`. No new plugin release is part of this operation.

## Live evidence and remaining deployment requirement

Gateway theme-route source `8695bacb67f43cf57479abd967709b02474cf3d4` was deployed as Worker version `9c66ce2f-3e3f-4251-8a10-102b1d79fc67`, build `production-20261015-theme-feed`, to the existing `phinix-plugin-repository-staging` service and both existing domains.

Production client transport/validators successfully downloaded, verified, installed into a fresh isolated store and reloaded both packages through GitHub direct. The CF route verified stable, published and catalog documents but failed at the first author-repository metadata lookup. Server trace request `999fa7a1-2c80-4438-9d8c-ac0a82044383` recorded upstream 403 with rateLimitRemaining 4952. The original gateway mislabeled every 403 as `OriginRateLimited`. This evidence excludes primary quota exhaustion; the exact GitHub error body was not captured. It does not establish game acceptance.

The follow-up implementation distinguishes rate exhaustion and recognized secondary-limit messages from access-denied responses. Upstream error bodies are bounded to 16 KiB and never logged or returned. Generic unknown 403 responses become `OriginAccessDenied`, not a guessed rate limit. Numeric rate diagnostics remain allowlisted.

Package credentials may now be scoped to one approved owner through nonsecret `PACKAGE_TOKEN_OWNER_ID` and secret `GITHUB_PACKAGE_TOKEN`. Catalog authority always uses existing `GITHUB_TOKEN`. Only after catalog validation and package selection may matching owner assets switch credentials; nonmatching package owners retain the original credential. Credential-scoped identity caches are cleared, while call counts and the original deadline remain unchanged. No authorization header follows a CDN redirect. Missing package credentials fail only the matching author's download path, preserving catalog and legacy package access.

Production and transitional configurations select organization owner ID `342817783`. Before deploying this follow-up, add `GITHUB_PACKAGE_TOKEN` to the existing Worker: a credential owned by `Phinix-Rework-Themes`, covering the two public theme repositories, with Metadata/Contents read only. Do not replace the original personal-repository credential. Secret values must never enter source, chat or reports.

At preparation time only the existing `GITHUB_TOKEN` secret name was present; the credential-routing follow-up has not yet been deployed. Verification: 169 Node tests, native workerd regression and production dry-run passed. Python operations (5), network (5) and live-probe (4) checks passed. A live original-plugin CF catalog/cache/304 revalidation check also passed against the unchanged snapshot and digest above (19 catalog records). This live check exercised the deployed theme-feed gateway, not the pending credential-routing deployment. CF theme package delivery and game acceptance remain pending.


## Superseding correction: arbitrary approved third-party themes

The owner-specific credential proposal above was withdrawn before deployment.
It is not the general third-party theme design, and no new organization secret
is required. Index now preserves the original author artifact record but also
publishes a byte-identical `theme-<ZIP SHA256>.zip` asset alongside catalog.json in
the same controlled snapshot Release. Publication validates any public author's
source/ZIP/manifest/XML and redistribution permission is part of maintainer review;
no author or organization allowlist is introduced. Stored mirror bytes are
redownloaded and verified before the Release/pointer becomes public. Public assets
are never clobbered in place. Record schema and client transports remain unchanged.

For schema4 theme requests CF selects the hash-addressed mirror from the exact
trusted catalog Release, verifies membership/size/hash, and applies the existing
stream verifier. It uses the existing Index credential only, never contacts the
author repository and never needs an author's secret. Original author identity
remains in the approved record and installed provenance; GitHub direct still
returns the author's original bytes. Old schema1/3 plugin delivery is unchanged.
Older theme snapshots without mirrors require refreshing to a new publication.

This is persistent distribution hosting in GitHub Releases, not enabled Cloudflare
ZIP caching. Production keeps R2 and edge ZIP storage disabled. White-box checks
prove the existing verified R2 layer can fill and hit a third-party theme using
its existing source/package/version/hash key, and reject bad streams; they do not
claim production cache is enabled. Metadata caching remains enabled.

Verification for this correction: 137 Index tests (one existing skip), 162 Node
tests and native workerd/production dry-run passed. Tests include an unrelated
third-party owner with no author network access, missing/duplicate/wrong-size/
wrong-digest/corrupt mirror assets, withdrawn records, cache fill/hit and byte
revalidation on publication retry. Actual publication/deployment and live results
are recorded below after verification.

### Verified deployed mirror delivery

- Index commit/snapshot: `20a6e446ac6f9c9ee1729668f555aac387bc026b`; publication run 38702787215 succeeded.
- Catalog SHA256: `b62360e5d17d42f94a4e1c7f94940fa25fbbfb22fbb3a3cd37895b272e4f4b75`.
- Snapshot Release ID: 413554870, containing catalog.json and both `theme-<sha256>.zip` copies; ZIP digests match original author assets above.
- Gateway source: `c2207a3a1bd55404b683c7dda2f08d6d16cf9e98`; CI 38702881411 succeeded.
- Worker version: `ccf0be0b-450d-4270-868b-8af699ac195c`, build `production-20261015-public-theme-mirrors`, both existing domains.
- Actual client CF transport, strict catalog/ZIP/manifest/XML validators, isolated installation and receipt reload passed for both themes against this snapshot.
- Actual original-plugin CF catalog/cache/304 regression passed; original snapshot/digest unchanged, 19 records.
- A new anonymous GitHub-direct probe hit remaining=0 (reset 1792051915), so this new-snapshot direct probe is rate-limited, not passed. The same original ZIP bytes passed the earlier direct probe.
- Neither transport-only check proves game UI acceptance. Subsequent player feedback identified a client theme-selection restore defect; local Host 0.10.4 repairs it and allows metadata caching on ordinary theme refresh while keeping the final installation recheck fresh. That Host patch requires separate client/game acceptance.

No organization-specific secret is needed. Production ZIP/R2 caching remains disabled; verified public Release mirrors provide persistent distribution hosting independently of player anonymous GitHub quota.
