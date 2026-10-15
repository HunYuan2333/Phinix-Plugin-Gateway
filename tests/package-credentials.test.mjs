import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway.mjs';
import { GitHubOrigin } from '../src/github.mjs';
import { Trace } from '../src/audit.mjs';
import { fixture, mockGithub, testEnv, context, traceCapture, digestFactory, sha, json } from './helpers.mjs';
const root = 'https://repo.example.test/v1/sources/test.local';
const packagePath = data => `${root}/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`;
for (const owner of ['20', '99', undefined]) test(`package credential is scoped to approved owner ${owner}`, async () => {
  const data = await fixture(), mock = mockGithub(data, { redirect: true }), capture = traceCapture();
  const worker = createGateway({ fetcher: mock.fetcher, sink: capture.sink, digestFactory });
  const response = await worker.fetch(new Request(packagePath(data)), testEnv({ GITHUB_TOKEN: 'ROOT_SECRET', PACKAGE_TOKEN_OWNER_ID: owner, GITHUB_PACKAGE_TOKEN: 'PACKAGE_SECRET' }), context());
  assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.payload);
  for (const call of mock.calls) {
    const expected = call.url.hostname !== 'api.github.com' ? null : 'Bearer ' +
      (owner === '20' && call.url.pathname.startsWith('/repos/author/package') ? 'PACKAGE_SECRET' : 'ROOT_SECRET');
    assert.equal(call.options.headers.get('Authorization'), expected);
  }
  assert(!JSON.stringify(capture.records).includes('SECRET'));
});
for (const token of [undefined, '', 'invalid token', 'x'.repeat(257)]) test(`matching owner fails closed with invalid token length ${token?.length}`, async () => {
  const data = await fixture(), mock = mockGithub(data), capture = traceCapture();
  const worker = createGateway({ fetcher: mock.fetcher, sink: capture.sink, digestFactory });
  const env = testEnv({ GITHUB_TOKEN: 'ROOT_SECRET', PACKAGE_TOKEN_OWNER_ID: '20', GITHUB_PACKAGE_TOKEN: token });
  assert.equal((await worker.fetch(new Request(root + '/stable'), env, context())).status, 200);
  const response = await worker.fetch(new Request(packagePath(data)), env, context());
  assert.equal((await response.json()).code, 'PackageCredentialsMissing');
  assert(!mock.calls.some(c => c.url.pathname.startsWith('/repos/author/')));
  const legacy = await worker.fetch(new Request(packagePath(data)), { ...env, PACKAGE_TOKEN_OWNER_ID: '99' }, context());
  assert.equal(legacy.status, 200); await legacy.arrayBuffer();
});
test('credential switch clears identity caches without resetting budgets', async () => {
  let now = 0;
  const origin = new GitHubOrigin({ token: 'ROOT_SECRET', now: () => now, maxCalls: 1, totalMs: 10, trace: new Trace({ sink: () => {} }), fetcher: async () => json({}) });
  await origin.json('/one'); origin.repos.set('old', {}); origin.releases.set('old', {});
  origin.useToken('PACKAGE_SECRET'); assert.equal(origin.repos.size, 0); assert.equal(origin.releases.size, 0);
  assert.equal(origin.calls, 1); assert.equal(origin.deadline, 10);
  await assert.rejects(origin.json('/two'), /OriginCallLimit/);
  now = 11; origin.useToken('OTHER_SECRET'); assert.equal(origin.deadline, 10);
});
for (const [message, headers, code] of [
  ['Resource not accessible by personal access token', { 'X-RateLimit-Remaining': '4952' }, 'OriginAccessDenied'],
  ['You have exceeded a secondary rate limit.', { 'X-RateLimit-Remaining': '4952' }, 'OriginRateLimited'],
  ['API rate limit exceeded', {}, 'OriginRateLimited'],
  ['SECRET_UNKNOWN_MESSAGE', {}, 'OriginAccessDenied'],
  ['SECRET_UNKNOWN_MESSAGE', { 'Retry-After': '30' }, 'OriginRateLimited'],
]) test(`forbidden classification ${code}: ${message.slice(0, 20)}`, async () => {
  const capture = traceCapture();
  const worker = createGateway({ sink: capture.sink, fetcher: async () => new Response(JSON.stringify({ message }), { status: 403, headers }) });
  const response = await worker.fetch(new Request(root + '/stable'), testEnv(), context());
  const body = await response.json(); assert.equal(body.code, code); assert.equal(body.retryable, code === 'OriginRateLimited');
  assert(!JSON.stringify(capture.records).includes(message)); assert(!JSON.stringify(body).includes(message));
});
test('oversized forbidden document stays bounded and does not mask status', async () => {
  const worker = createGateway({ sink: () => {}, fetcher: async () => new Response('x'.repeat(16385), { status: 403 }) });
  assert.equal((await (await worker.fetch(new Request(root + '/stable'), testEnv(), context())).json()).code, 'OriginAccessDenied');
});
for (const owner of ['', '0', '01', 'owner', '20\n', 20]) test(`invalid package owner configuration ${JSON.stringify(owner)}`, async () => {
  const data = await fixture(), mock = mockGithub(data);
  const worker = createGateway({ fetcher: mock.fetcher, sink: () => {}, digestFactory });
  const response = await worker.fetch(new Request(packagePath(data)), testEnv({ PACKAGE_TOKEN_OWNER_ID: owner, GITHUB_PACKAGE_TOKEN: 'PACKAGE_SECRET' }), context());
  assert.equal((await response.json()).code, 'InvalidPackageCredentialOwner');
  assert(!mock.calls.some(c => c.url.pathname.startsWith('/repos/author/')));
});
