import { GatewayError, safeError } from './audit.mjs';
import { requireThat } from './protocol.mjs';

const toHex = buffer => Array.from(new Uint8Array(buffer), n => n.toString(16).padStart(2, '0')).join('');
function deadline(promise, milliseconds, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new GatewayError(code, 503, true)), milliseconds); })]).finally(() => clearTimeout(timer));
}
// One upstream reader. The optional cache writer shares backpressure for <=200ms;
// no ReadableStream.tee()/Response.clone() can accumulate an unbounded slow branch.
export function verifiedStream(body, expected, trace, { digestFactory = () => new crypto.DigestStream('SHA-256'), cacheWriter = null, idleMs = 6000, totalMs = 30000, lagMs = 200 } = {}) {
  const reader = body.getReader(), hasher = digestFactory(), hashWriter = hasher.getWriter();
  hasher.digest.catch(() => {});
  const started = Date.now(); let bytes = 0, cache = cacheWriter, ended = false;
  const dropCache = async reason => {
    if (!cache) return; const writer = cache; cache = null;
    trace.event('cache.branch_dropped', { reason }, 'warn');
    // Abort may wait for an underlying IO operation; never make serving await it indefinitely.
    writer.abort(new Error(reason)).catch(() => {});
  };
  async function fail(controller, error) {
    if (ended) return; ended = true;
    reader.cancel(error).catch(() => {}); hashWriter.abort(error).catch(() => {}); await dropCache(safeError(error));
    trace.event('stream.failed', { reason: safeError(error), bytes, expectedBytes: expected.sizeBytes }, 'error');
    trace.finish(502, safeError(error), bytes); controller.error(error);
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const remaining = totalMs - (Date.now() - started); requireThat(remaining > 0, 'StreamTotalTimeout', 503);
        const part = await deadline(reader.read(), Math.min(remaining, idleMs), 'StreamIdleTimeout');
        requireThat(!part.done, 'StreamLengthMismatch');
        requireThat(part.value instanceof Uint8Array && part.value.byteLength <= 1024 * 1024, 'StreamChunkLimit');
        bytes += part.value.byteLength; requireThat(bytes <= expected.sizeBytes, 'StreamLengthMismatch');
        await hashWriter.write(part.value);
        if (cache) { try { await deadline(cache.write(part.value), lagMs, 'CacheBranchSlow'); } catch { await dropCache('CacheBranchFailedOrSlow'); } }
        if (bytes === expected.sizeBytes) {
          // Hold the final bounded chunk until upstream EOF and digest are proven.
          // Content-Length clients may finish as soon as they see the last byte;
          // a later digest error would then be too late to fail their response.
          const tail = await deadline(reader.read(), Math.min(idleMs, Math.max(1, totalMs - (Date.now() - started))), 'StreamIdleTimeout');
          requireThat(tail.done, 'StreamLengthMismatch');
          await hashWriter.close(); requireThat(toHex(await hasher.digest) === expected.sha256, 'StreamDigestMismatch');
          if (cache) { try { await deadline(cache.close(), lagMs, 'CacheBranchSlow'); } catch { await dropCache('CacheBranchSlow'); } }
          ended = true; trace.event('stream.verified', { bytes }); trace.finish(200, 'StreamVerified', bytes);
          controller.enqueue(part.value); controller.close(); return;
        }
        controller.enqueue(part.value);
      } catch (error) { await fail(controller, error); }
    },
    async cancel() {
      if (ended) return; ended = true; reader.cancel().catch(() => {}); hashWriter.abort().catch(() => {}); await dropCache('ClientCancelled');
      trace.event('stream.cancelled', { bytes }, 'warn'); trace.finish(499, 'ClientCancelled', bytes);
    }
  }, { highWaterMark: 0 });
}
export function startFill(stub, entry, trace, context, pipeFactory = size => new FixedLengthStream(size)) {
  const pipe = pipeFactory(entry.sizeBytes);
  const operation = Promise.resolve().then(() => stub.fetch(new Request('https://cache.internal/put', { method: 'POST', body: pipe.readable, duplex: 'half', headers: {
    'X-Phinix-Request-Id': trace.id, 'X-Phinix-Cache-Entry': JSON.stringify(entry),
    ...(trace.base.clientRequestId ? { 'X-Phinix-Client-Request-Id': trace.base.clientRequestId } : {})
  } }))).then(async response => {
    trace.event('cache.fill_result', { status: response.status, reason: response.status === 201 ? 'Stored' : 'NotConfirmed' }, response.status === 201 ? 'info' : 'warn');
    if (response.body) response.body.cancel().catch(() => {});
    if (response.status !== 201) pipe.readable.cancel().catch(() => {});
  }).catch(error => { trace.event('cache.fill_result', { reason: safeError(error) }, 'warn'); pipe.readable.cancel().catch(() => {}); });
  context.waitUntil(operation);
  return pipe.writable.getWriter();
}
