import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway.mjs';
import { testEnv, context, traceCapture } from './helpers.mjs';
const root = 'https://repo.example.test/v1/sources/test.local';
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
