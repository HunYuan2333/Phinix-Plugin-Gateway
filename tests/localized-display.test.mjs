import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateDisplayLocalization } from '../src/localized-display.mjs';
import { strictJson, stable } from '../src/protocol.mjs';
const bytes = await readFile(new URL('./fixtures/localization-display.json', import.meta.url));
for (const fixture of strictJson(bytes, 256 * 1024).cases) {
  test(`shared catalog display fixture: ${fixture.id}`, () => {
    if (fixture.code) assert.throws(() => validateDisplayLocalization(fixture.localization), error => error.code === fixture.code);
    else assert.equal(validateDisplayLocalization(fixture.localization), fixture.localization);
  });
}
test('v2 managed envelope is rejected without a compatibility reader', () => {
  const value = {schemaVersion: 1, sourceId: 'test.source', snapshotId: 'a'.repeat(40), catalogSchemaVersion: 2,
    catalogSha256: 'b'.repeat(64), catalogSizeBytes: 100, publishedSha256: 'c'.repeat(64), publishedSizeBytes: 100};
  assert.throws(() => stable(new TextEncoder().encode(JSON.stringify(value)), 'test.source'), /UnsupportedSchema/);
});
