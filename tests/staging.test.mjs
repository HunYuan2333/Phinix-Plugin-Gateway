import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyGateway } from '../src/read-only.mjs';
import { fixture, mockGithub, testEnv, context, traceCapture, digestFactory, sha } from './helpers.mjs';

const root = 'https://staging.example.test/v1/sources/test.local';
const env = extra => testEnv({ REPOSITORY_ENABLED: 'true', POC_MODE: 'false', GITHUB_TOKEN: 'SECRET_ORIGIN_TOKEN',
  REQUEST_LIMITER: { limit: async () => ({ success: true }) }, ...extra });
const worker = (mock, capture) => createReadOnlyGateway({ fetcher: mock.fetcher, sink: capture.sink, digestFactory });

for (const [name, extra, code] of [
  ['closed', { REPOSITORY_ENABLED: 'false' }, 'RepositoryClosed'],
  ['missing token', { GITHUB_TOKEN: undefined }, 'OriginCredentialsMissing'],
  ['malformed token', { GITHUB_TOKEN: 'SECRET\nTOKEN' }, 'OriginCredentialsMissing'],
  ['missing limiter', { REQUEST_LIMITER: undefined }, 'RepositoryLimiterUnavailable'],
  ['invalid limiter reply', { REQUEST_LIMITER: { limit: async () => ({}) } }, 'RepositoryLimiterUnavailable'],
  ['cache enabled', { R2_ENABLED: 'true' }, 'ReadOnlyConfigurationInvalid'],
  ['unexpected bucket', { PACKAGES: {} }, 'ReadOnlyConfigurationInvalid'],
  ['unexpected ledger', { CACHE_COORDINATOR: {} }, 'ReadOnlyConfigurationInvalid']
]) test('staging '+name+' refuses origin access', async () => {
  let calls = 0; const capture = traceCapture();
  const gateway = createReadOnlyGateway({ sink: capture.sink, fetcher: () => { calls++; } });
  const response = await gateway.fetch(new Request(root+'/stable'), env(extra), context());
  assert.equal(response.status, 503); assert.equal((await response.json()).code, code); assert.equal(calls, 0);
  assert.equal(capture.records.filter(r => r.event === 'request.complete').length, 1);
  assert(!JSON.stringify(capture.records).includes('SECRET'));
});

test('staging limiter denies before GitHub and keeps caller secrets out of audit', async () => {
  let calls = 0; const keys = [], capture = traceCapture();
  const gateway = createReadOnlyGateway({ sink: capture.sink, fetcher: () => { calls++; } });
  const response = await gateway.fetch(new Request(root+'/stable', { headers: { Authorization: 'SECRET_CLIENT_TOKEN' } }),
    env({ REQUEST_LIMITER: { limit: async input => { keys.push(input.key); return { success: false }; } } }), context());
  assert.equal(response.status, 429); assert.equal((await response.json()).code, 'RepositoryRateLimited');
  assert.equal(calls, 0); assert.deepEqual(keys, ['phinix-repository-read-only']);
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert(!JSON.stringify(capture.records).includes('SECRET'));
});

test('staging limiter exception is sanitized and does not admit origin', async () => {
  let calls = 0; const capture = traceCapture();
  const gateway = createReadOnlyGateway({ sink: capture.sink, fetcher: () => { calls++; } });
  const response = await gateway.fetch(new Request(root+'/stable'), env({ REQUEST_LIMITER: { limit: async () => { throw Error('SECRET'); } } }), context());
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'InternalFailure');
  assert.equal(calls, 0); assert(!JSON.stringify(capture.records).includes('SECRET'));
});

test('staging invalid paths, sources and methods never consume limiter or origin', async () => {
  let calls = 0, limits = 0; const gateway = createReadOnlyGateway({ sink: () => {}, fetcher: () => { calls++; } });
  const bindings = env({ REQUEST_LIMITER: { limit: async () => { limits++; return { success: true }; } } });
  for (const request of [new Request(root+'/stable?url=SECRET'), new Request(root+'/stable', { method: 'POST' }),
    new Request(root.replace('test.local','unknown')+'/stable'), new Request(root+'/stable', { headers: { Range: 'bytes=0-1' } })])
    assert((await gateway.fetch(request, bindings, context())).status >= 400);
  assert.equal(calls, 0); assert.equal(limits, 0);
});

test('public staging verifies anonymous metadata, conditional response and ZIP without cache resources', async () => {
  const data = await fixture(), mock = mockGithub(data, { redirect: true }), capture = traceCapture(), gateway = worker(mock, capture);
  const bindings = env(); let response = await gateway.fetch(new Request(root+'/stable'), bindings, context());
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const etag = response.headers.get('ETag'); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.stable);
  response = await gateway.fetch(new Request(root+'/stable', { headers: { 'If-None-Match': etag } }), bindings, context());
  assert.equal(response.status, 304); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  for (const [path, bytes] of [
    [`/snapshots/${data.snapshot}/published/${sha(data.published)}`, data.published],
    [`/snapshots/${data.snapshot}/catalog/${sha(data.catalog)}`, data.catalog],
    [`/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`, data.payload]
  ]) {
    response = await gateway.fetch(new Request(root+path), bindings, context());
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
  assert(capture.records.some(r => r.event === 'repository.read_admitted'));
  assert(capture.records.some(r => r.event === 'stream.verified'));
  assert(!capture.records.some(r => r.component === 'cache'));
  assert(mock.calls.some(c => c.url.hostname === 'api.github.com' && c.options.headers.get('Authorization') === 'Bearer SECRET_ORIGIN_TOKEN'));
  assert(mock.calls.filter(c => c.url.hostname === 'release-assets.githubusercontent.com').every(c => !c.options.headers.has('Authorization')));
  assert(!JSON.stringify(capture.records).includes('SECRET'));
});
