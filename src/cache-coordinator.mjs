import { Trace, safeError, errorResponse, GatewayError } from './audit.mjs';
import { CacheLedger, cacheEntry, cacheConfig } from './cache-ledger.mjs';
import { boundedBody } from './github.mjs';
import { strictJson, requireThat } from './protocol.mjs';
import { CacheOperations } from './cache-operations.mjs';

export class CacheCoordinatorCore {
  constructor(storage, env, { sink, now = Date.now, digestFactory } = {}) {
    this.env = env; this.sink = sink; this.now = now; this.config = cacheConfig(env);
    this.ledger = new CacheLedger(storage, this.config, now); this.active = new Set(); this.bootstrap = null;
    this.operations = new CacheOperations(this, { digestFactory });
  }
  async initialize(trace) {
    if (this.ledger.meta().status === 'ready') return;
    if (this.bootstrap) return this.bootstrap;
    if (this.ledger.meta().status !== 'uninitialized') throw new GatewayError('CacheLedgerUnavailable', 503);
    this.bootstrap = (async () => {
      this.ledger.beginBootstrap(trace);
      // Exactly one pre-counted list. An interrupted initialization stays closed on restart.
      const listed = await this.env.PACKAGES.list({ limit: 1 });
      const empty = listed.objects.length === 0 && listed.truncated === false;
      if (empty) await this.env.PACKAGES.put('__phinix/cache-ledger/' + this.config.epoch,
        JSON.stringify({ schemaVersion: 1, epoch: this.config.epoch }), { storageClass: 'Standard' });
      // A persistent marker also detects ledger loss after every package has been evicted.
      this.ledger.finishBootstrap(empty, trace);
      requireThat(empty, 'CacheBootstrapRejected', 503);
    })();
    return this.bootstrap;
  }
  async fetch(request) {
    const trace = new Trace({ sink: this.sink, now: this.now, component: 'cache', build: this.env.BUILD_ID, clientId: request.headers.get('X-Phinix-Client-Request-Id'),
      id: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.headers.get('X-Phinix-Request-Id') ?? '') ? request.headers.get('X-Phinix-Request-Id') : crypto.randomUUID() });
    try {
      requireThat(request.method === 'POST', 'MethodNotAllowed', 405);
      const path = new URL(request.url).pathname;
      requireThat(path === '/get' || path === '/put', 'RouteNotFound', 404);
      const descriptor = path === '/get' ? strictJson(await boundedBody(request, 2048), 2048) : strictJson(new TextEncoder().encode(request.headers.get('X-Phinix-Cache-Entry') ?? ''), 2048);
      const entry = cacheEntry(descriptor); trace.base.source = entry.source; trace.base.package = entry.package; trace.base.version = entry.version; trace.base.sha256 = entry.sha256;
      await this.initialize(trace); this.ledger.check(this.ledger.meta());
      return path === '/get' ? await this.get(entry, trace) : await this.put(entry, request.body, trace);
    } catch (error) { if (request.body) request.body.cancel().catch(() => {}); return errorResponse(error, trace); }
  }
  async get(entry, trace) {
    const tracked = this.ledger.entry(entry.key);
    if (!tracked || !['ready', 'verified'].includes(tracked.state)) { trace.event('cache.miss', { reason: tracked ? 'UnconfirmedObject' : 'NotTracked' }); trace.finish(404, 'CacheMiss'); return new Response(null, { status: 404 }); }
    requireThat(tracked.sizeBytes === entry.sizeBytes && tracked.sha256 === entry.sha256, 'CacheIdentityMismatch', 503);
    this.ledger.spend('B', trace);
    let stored;
    try { stored = await this.env.PACKAGES.get(entry.key); }
    catch (error) { trace.event('cache.read_failed', { reason: safeError(error) }, 'warn'); throw new GatewayError('CacheReadFailed', 503, true); }
    if (stored === null) {
      this.ledger.pause(trace, 'TrackedObjectMissing'); trace.finish(404, 'CacheMiss'); return new Response(null, { status: 404 });
    }
    const checksum = stored.checksums?.sha256;
    const hash = checksum && Array.from(new Uint8Array(checksum), n => n.toString(16).padStart(2, '0')).join('');
    if (stored.size !== entry.sizeBytes || hash !== entry.sha256 || !stored.body || stored.customMetadata?.sha256 !== entry.sha256) {
      if (stored.body) stored.body.cancel().catch(() => {});
      this.ledger.pause(trace, 'StoredObjectMismatch'); throw new GatewayError('CacheIntegrityFailed', 503);
    }
    trace.event('cache.hit', { bytes: stored.size }); trace.finish(200, 'CacheHit', stored.size);
    return new Response(stored.body, { headers: { 'Content-Length': String(stored.size), 'Content-Type': 'application/octet-stream' } });
  }
  async put(entry, body, trace) {
    requireThat(body && entry.sizeBytes <= this.config.maxFillBytes, 'CacheFillSizeLimit', 409);
    const meta = this.ledger.meta();
    requireThat(meta.classA < this.config.classA && meta.classB < this.config.classB, 'CacheBudgetExceeded', 503);
    requireThat(!this.ledger.entry(entry.key), 'CacheFillAlreadyTracked', 409);
    const totals = this.ledger.totals();
    if (totals.usedBytes + totals.reservedBytes + entry.sizeBytes + 2048 > this.config.capacity) {
      for (const candidate of this.ledger.evictionCandidates(entry).slice(0, 4)) {
        this.ledger.beginDelete(candidate.key, trace);
        try { await this.env.PACKAGES.delete(candidate.key); this.ledger.finishDelete(candidate.key, trace); }
        catch (error) { trace.event('cache.delete_uncertain', { reason: safeError(error) }, 'warn'); throw new GatewayError('CacheDeleteUnconfirmed', 503); }
        const next = this.ledger.totals(); if (next.usedBytes + next.reservedBytes + entry.sizeBytes + 2048 <= this.config.capacity) break;
      }
    }
    const lease = this.ledger.reserve(entry, trace); this.active.add(entry.key);
    try {
      // R2 owns the checksum validation; its completion is separate from the SQL transaction.
      const stored = await this.env.PACKAGES.put(entry.key, body, { sha256: entry.sha256, storageClass: 'Standard',
        customMetadata: { sha256: entry.sha256, source: entry.source, package: entry.package, version: entry.version } });
      requireThat(stored !== null && stored.size === entry.sizeBytes, 'CachePutMismatch', 503);
      this.ledger.complete(entry.key, lease, trace); trace.finish(201, 'CacheFillComplete', entry.sizeBytes);
      return new Response(null, { status: 201 });
    } catch (error) {
      const reason = safeError(error);
      try { this.ledger.uncertain(entry.key, lease, trace, reason); } catch { trace.event('cache.ledger_commit_unknown', { lease, reason: 'PersistentReservationRetained' }, 'error'); }
      throw new GatewayError('CacheFillUnconfirmed', 503, true);
    } finally { this.active.delete(entry.key); }
  }
}
