// Disposable per-isolate metadata only. No payloads, failures, stale-on-error or durable authority.
export class OriginMetadataCache {
  constructor({ now = Date.now, maxEntries = 64, maxBytes = 2 * 1024 * 1024, maxEntryBytes = 64 * 1024, maxInflight = 16 } = {}) {
    this.now = now; this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.maxEntryBytes = maxEntryBytes; this.maxInflight = maxInflight;
    this.entries = new Map(); this.inflight = new Map(); this.bytes = 0;
  }
  remove(key) { const entry = this.entries.get(key); if (entry) { this.bytes -= entry.bytes.byteLength; this.entries.delete(key); } }
  async read(key, ttlMs, load, trace) {
    const now = this.now();
    for (const [id, entry] of this.entries) if (now >= entry.createdAt + entry.ttlMs) this.remove(id);
    const entry = this.entries.get(key);
    if (entry && now < entry.createdAt + ttlMs) {
      this.entries.delete(key); this.entries.set(key, entry);
      trace.event('origin.metadata_hit', { bytes: entry.bytes.byteLength, metadataAgeSeconds: Math.ceil((now - entry.createdAt) / 1000) });
      return { bytes: entry.bytes.slice(), createdAt: entry.createdAt };
    }
    if (entry) this.remove(key);
    const existing = this.inflight.get(key);
    if (existing && now < existing.startedAt + ttlMs) {
      trace.event('origin.metadata_join'); const result = await existing.promise;
      return { bytes: result.bytes.slice(), createdAt: result.createdAt };
    }
    trace.event('origin.metadata_miss');
    const startedAt = now, slot = { startedAt };
    const operation = (async () => {
      const bytes = await load();
      // Freshness starts when the lookup starts, not when a slow response eventually arrives.
      if (this.now() < startedAt + ttlMs && bytes.byteLength <= this.maxEntryBytes && bytes.byteLength <= this.maxBytes && this.maxEntries > 0) {
        this.remove(key);
        while (this.entries.size >= this.maxEntries || this.bytes + bytes.byteLength > this.maxBytes) this.remove(this.entries.keys().next().value);
        const stored = bytes.slice(); this.entries.set(key, { bytes: stored, createdAt: startedAt, ttlMs }); this.bytes += stored.byteLength;
      }
      return { bytes, createdAt: startedAt };
    })();
    slot.promise = operation;
    const tracked = !existing && this.inflight.size < this.maxInflight;
    if (tracked) this.inflight.set(key, slot);
    try { return await operation; }
    finally { if (this.inflight.get(key) === slot) this.inflight.delete(key); }
  }
}
