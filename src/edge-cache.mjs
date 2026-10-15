// Only a fully verified bounded body may enter Cache API; no stream tee/clone.
export function edgeCacheLayer(cache, { maxBytes = 8 * 1024 * 1024, maxConcurrent = 2 } = {}) {
  let active = 0;
  return {
    async read(key, expected, trace, context) {
      if (!cache) return null;
      try {
        const response = await cache.match(key);
        if (!response) { trace.event('cache.edge_miss'); return null; }
        if (response.status !== 200 || response.headers.get('Content-Length') !== String(expected.sizeBytes) ||
            response.headers.get('Content-Type') !== 'application/octet-stream' || response.headers.has('Content-Encoding') ||
            response.headers.has('Content-Range') || response.headers.get('ETag') !== '"sha256-' + expected.sha256 + '"' || !response.body) {
          response.body?.cancel().catch(() => {}); context.waitUntil(cache.delete(key).catch(() => {}));
          trace.event('cache.edge_bypass', { reason: 'StoredMetadataMismatch' }); return null;
        }
        trace.event('cache.edge_hit', { expectedBytes: expected.sizeBytes }); return response.body;
      } catch { trace.event('cache.edge_bypass', { reason: 'CacheUnavailable' }); return null; }
    },
    discard(key, context) { if (cache) context.waitUntil(cache.delete(key).catch(() => {})); },
    writer(key, expected, trace, context) {
      if (!cache || expected.sizeBytes > maxBytes || active >= maxConcurrent) {
        trace.event('cache.edge_fill_skipped', { reason: !cache ? 'CacheUnavailable' : expected.sizeBytes > maxBytes ? 'SizeLimit' : 'ConcurrencyLimit' }); return null;
      }
      active++; let chunks = [], size = 0, finished = false;
      const release = () => { chunks = []; active--; };
      return {
        async write(chunk) { if (finished || size + chunk.byteLength > expected.sizeBytes) throw Error('EdgeFillLimit'); size += chunk.byteLength; chunks.push(chunk.slice()); },
        async close() {
          if (finished) return; finished = true;
          if (size !== expected.sizeBytes) { release(); return; }
          const response = new Response(new Blob(chunks), { headers: { 'Content-Type': 'application/octet-stream',
            'Content-Length': String(size), ETag: '"sha256-' + expected.sha256 + '"', 'Cache-Control': 'public, max-age=86400, immutable' } });
          chunks = [];
          // Called only after verifiedStream proves EOF/length/hash. Cache API may
          // silently decline storage, so log submission, never claim a hit here.
          context.waitUntil(Promise.resolve().then(() => cache.put(key, response)).then(() => trace.event('cache.edge_store_submitted', { bytes: size }),
            () => trace.event('cache.edge_bypass', { reason: 'CacheWriteFailed' })).finally(release));
        },
        async abort() { if (!finished) { finished = true; release(); } }
      };
    }
  };
}
export function combineCacheWriters(first, second) {
  if (!first) return second; if (!second) return first;
  return { write: chunk => Promise.all([first.write(chunk), second.write(chunk)]),
    close: () => Promise.all([first.close(), second.close()]),
    abort: reason => Promise.allSettled([first.abort(reason), second.abort(reason)]) };
}
