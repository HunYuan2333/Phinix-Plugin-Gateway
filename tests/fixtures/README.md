# Shared protocol fixture snapshot

[中文](README.zh-CN.md).

These byte-identical fixtures are imported from the client protocol tests in Phinix-Rework. `provenance.json` records their source paths, sizes and SHA-256. They are a reviewed working-tree snapshot, not attributed to an unrelated committed version.

Gateway tests read only this directory; they do not require a sibling client checkout. Update fixtures from the canonical client tests, review the corresponding client/Index/Gateway behavior together, replace bytes and provenance in one change, and run the conformance tests. Do not edit each repository's copy into different protocol rules.

The chain fixture exercises historical metadata v1; localization and managed-protocol tests separately cover current catalog v3. Keeping this test input does not add an obsolete production source.
