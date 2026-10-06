import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, selectedPackage, stable } from '../src/protocol.mjs';
import { createReadOnlyGateway } from '../src/read-only.mjs';
import { fixture, encode, sha, source, mockGithub, testEnv, context, traceCapture, digestFactory } from './helpers.mjs';

async function managedFixture() {
  const data = await fixture();
  const old = JSON.parse(new TextDecoder().decode(data.catalog)).packages[0];
  const record = { id: old.id, localization: { translations: { "en-US": { name: old.name, summary: "Test" } } }, state: 'active', channel: 'github-release', management: 'phinix-dll',
    manifest: { schemaVersion: 1, management: 'phinix-dll', packageId: old.id, version: old.version }, artifact: { ...data.artifact, payloadKind: 'managed-dll-zip' } };
  data.artifact = record.artifact;
  data.catalog = encode({ schemaVersion: 3, sourceId: source.sourceId, snapshotId: data.snapshot, packages: [record] });
  data.publishedObject = { ...data.publishedObject, catalogSchemaVersion: 3, catalogSha256: sha(data.catalog), catalogSizeBytes: data.catalog.length };
  data.published = encode(data.publishedObject);
  const { repository, repositoryId, ownerId, releaseId, assetId, assetName, ...common } = data.publishedObject;
  data.stable = encode({ ...common, publishedSha256: sha(data.published), publishedSizeBytes: data.published.length });
  return data;
}
test('managed catalog routes manifest version and rejects both format reinterpretations', async () => {
  const data = await managedFixture();
  assert.equal(stable(data.stable, source.sourceId).catalogSchemaVersion, 3);
  const index = await catalog(data.catalog, data.publishedObject);
  const path = { package: 'a', version: '1.0.0', hash: data.artifact.sha256 };
  assert.equal(selectedPackage(index, path).payloadKind, 'managed-dll-zip');
  const record = index.packages[0];
  record.artifact.payloadKind = 'rimworld-mod-zip'; assert.throws(() => selectedPackage(index, path), /PayloadNotSupported/);
  record.artifact.payloadKind = 'managed-dll-zip'; record.management = 'rimworld-mod'; assert.throws(() => selectedPackage(index, path), /ManagedIdentityMismatch/);
  record.management = 'phinix-dll'; record.manifest.packageId = 'forged'; assert.throws(() => selectedPackage(index, path), /ManagedIdentityMismatch/);
  await assert.rejects(catalog(data.catalog, { ...data.publishedObject, catalogSchemaVersion: 1 }), /CatalogIdentityMismatch/);
});
test('managed package uses existing verified anonymous staging stream without changing v1', async () => {
  const data = await managedFixture(), mock = mockGithub(data), capture = traceCapture(), tasks = context();
  const gateway = createReadOnlyGateway({ fetcher: mock.fetcher, sink: capture.sink, digestFactory });
  const env = testEnv({ REPOSITORY_ENABLED: 'true', POC_MODE: 'false', GITHUB_TOKEN: 'SECRET', REQUEST_LIMITER: { limit: async () => ({ success: true }) } });
  const response = await gateway.fetch(new Request(`https://store.test/v1/sources/test.local/snapshots/${data.snapshot}/packages/a/1.0.0/${data.artifact.sha256}/package`), env, tasks);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Length'), String(data.payload.length));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.payload); await tasks.flush();
  assert(capture.records.some(r => r.event === 'stream.verified')); assert(!JSON.stringify(capture.records).includes('SECRET'));
});
