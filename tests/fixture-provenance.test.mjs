import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('standalone fixtures retain the reviewed client conformance snapshot', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/provenance.json', import.meta.url), 'utf8'));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.canonicalRepository, 'HunYuan2333/Phinix-Rework');
  assert.deepEqual(provenance.fixtures.map(record => record.path), ['chain.catalog.json', 'localization-display.json']);
  for (const record of provenance.fixtures) {
    const bytes = await readFile(new URL('./fixtures/' + record.path, import.meta.url));
    assert.equal(bytes.length, record.sizeBytes, record.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, record.path);
  }
});
