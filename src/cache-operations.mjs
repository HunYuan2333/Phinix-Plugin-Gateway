import { Trace, safeError, GatewayError } from './audit.mjs';
import { cacheEntry } from './cache-ledger.mjs';
import { object, requireThat, hex, digest } from './protocol.mjs';

export class CacheOperations {
  constructor(core, { digestFactory = () => new crypto.DigestStream('SHA-256'), idleMs = 6000, totalMs = 30000 } = {}) {
    this.core = core; this.digestFactory = digestFactory; this.idleMs = idleMs; this.totalMs = totalMs; this.recovering = new Set();
  }
  async run(action, input) {
    const core = this.core, trace = new Trace({ sink: core.sink, now: core.now, component: 'cache', build: core.env.BUILD_ID });
    let recoveryKey = null;
    trace.event('cache.operations_requested', { stage: action });
    try {
      requireThat(['inspect', 'confirm'].includes(action), 'InvalidRecoveryAction', 400);
      requireThat(core.env.CACHE_OPERATIONS_ENABLED === 'true', 'CacheOperationsDisabled', 403);
      object(input, action === 'inspect' ? ['schemaVersion', 'epoch', 'period'] : ['schemaVersion', 'epoch', 'period', 'entry', 'lease', 'fingerprint']);
      requireThat(input.schemaVersion === 1 && /^[a-z0-9-]{1,64}$/.test(input.epoch ?? '') && /^[a-z0-9-]{1,64}$/.test(input.period ?? ''), 'InvalidRecoveryInput', 400);
      const meta = core.ledger.meta();
      requireThat(meta.epoch === input.epoch && meta.period === input.period && meta.epoch === core.config.epoch && meta.period === core.config.period && meta.start === core.config.start && meta.end === core.config.end, 'CacheRecoveryTargetMismatch', 409);
      trace.base.period = meta.period;
      let result;
      if (action === 'inspect') {
        const snapshot = core.ledger.storage.transactionSync(() => ({ meta: core.ledger.meta(), entries: core.ledger.entries(), totals: core.ledger.totals(), journal: core.ledger.sql.exec('SELECT seq,request_id,event,time,value FROM audit ORDER BY seq DESC LIMIT 64').toArray() }));
        const entries = snapshot.entries; requireThat(entries.length <= 256, 'CacheLedgerRowLimit', 503);
        const objects = [];
        for (const entry of entries) objects.push({ entry, fingerprint: await digest(new TextEncoder().encode(JSON.stringify(entry))), active: core.active.has(entry.key) });
        const journal = snapshot.journal.map(row => ({ sequence: row.seq, requestId: row.request_id, event: row.event, time: row.time, values: JSON.parse(row.value) }));
        result = { meta: snapshot.meta, totals: snapshot.totals, objects, journal };
        trace.event('cache.operations_inspected', { rows: objects.length, ...result.totals, classA: snapshot.meta.classA, classB: snapshot.meta.classB });
      } else {
        const entry = cacheEntry(input.entry); hex(input.fingerprint);
        requireThat(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.lease ?? ''), 'InvalidRecoveryLease', 400);
        Object.assign(trace.base, { source: entry.source, package: entry.package, version: entry.version, sha256: entry.sha256, lease: input.lease });
        requireThat(!core.active.has(entry.key), 'CacheRecoveryActiveWrite', 409);
        const tracked = core.ledger.entry(entry.key);
        requireThat(tracked && tracked.lease === input.lease && ['writing', 'uncertain'].includes(tracked.state) && tracked.sizeBytes === entry.sizeBytes && tracked.sha256 === entry.sha256, 'CacheRecoveryStateMismatch', 409);
        requireThat(core.now() >= tracked.expires, 'CacheRecoveryLeaseNotExpired', 409);
        requireThat(entry.sizeBytes <= core.config.maxFillBytes, 'CacheRecoverySizeLimit', 409);
        const expected = JSON.stringify(tracked);
        requireThat(await digest(new TextEncoder().encode(expected)) === input.fingerprint, 'CacheRecoveryInspectionStale', 409);
        requireThat(!this.recovering.has(entry.key), 'CacheRecoveryInProgress', 409);
        requireThat(this.recovering.size < 4, 'CacheRecoveryConcurrencyLimit', 409);
        this.recovering.add(entry.key); recoveryKey = entry.key;
        core.ledger.reserveRecoveryRead(entry.key, expected, trace);
        let stored;
        try {
          let received = false;
          const lookup = Promise.resolve().then(() => core.env.PACKAGES.get(entry.key));
          try { stored = await timed(lookup, this.idleMs); received = true; }
          finally { if (!received) lookup.then(late => late?.body?.cancel().catch(() => {}), () => {}); }
          requireThat(stored && stored.body, 'CacheRecoveryObjectMissing', 409);
          const checksum = stored.checksums?.sha256;
          const hash = checksum && Array.from(new Uint8Array(checksum), n => n.toString(16).padStart(2, '0')).join('');
          requireThat(stored.size === entry.sizeBytes && hash === entry.sha256 && stored.customMetadata?.sha256 === entry.sha256 && stored.customMetadata?.source === entry.source && stored.customMetadata?.package === entry.package && stored.customMetadata?.version === entry.version, 'CacheRecoveryObjectMismatch', 409);
          await verifyBody(stored.body, entry, this.digestFactory, core.now, this.idleMs, this.totalMs);
          trace.event('cache.recovery_bytes_verified', { bytes: entry.sizeBytes });
          core.ledger.confirmRecovery(entry.key, expected, trace);
        } catch (error) {
          stored?.body?.cancel().catch(() => {});
          try { core.ledger.transaction(trace, () => core.ledger.audit(trace, 'cache.recovery_failed', { reason: safeError(error), ...core.ledger.totals() })); }
          catch { trace.event('cache.recovery_journal_failed', { reason: 'PersistentReservationRetained' }, 'error'); }
          throw error;
        }
        result = { state: 'verified', totals: core.ledger.totals(), capacityReleased: false, cacheStatus: core.ledger.meta().status };
      }
      trace.finish(200, action === 'inspect' ? 'CacheInspected' : 'CacheRecoveryConfirmed');
      return { schemaVersion: 1, ok: true, requestId: trace.id, result };
    } catch (error) {
      const known = error instanceof GatewayError ? error : new GatewayError(safeError(error), 503, true);
      trace.event('cache.operations_rejected', { reason: known.code, status: known.status }, 'warn'); trace.finish(known.status, known.code);
      return { schemaVersion: 1, ok: false, requestId: trace.id, code: known.code, status: known.status, retryable: known.retryable };
    } finally { if (recoveryKey !== null) this.recovering.delete(recoveryKey); }
  }
}

async function timed(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new GatewayError('CacheRecoveryReadTimeout', 503, true)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function verifyBody(body, entry, digestFactory, now, idleMs, totalMs) {
  const reader = body.getReader(), hasher = digestFactory(), writer = hasher.getWriter(), started = now(); let bytes = 0;
  hasher.digest.catch(() => {});
  const withinBudget = operation => {
    const remaining = totalMs - (now() - started); requireThat(remaining > 0, 'CacheRecoveryReadTimeout', 503);
    return timed(operation(), Math.min(idleMs, remaining));
  };
  try {
    while (true) {
      const chunk = await withinBudget(() => reader.read());
      if (chunk.done) break;
      requireThat(chunk.value instanceof Uint8Array && chunk.value.byteLength <= 1024 * 1024, 'CacheRecoveryChunkLimit', 409);
      bytes += chunk.value.byteLength; requireThat(bytes <= entry.sizeBytes, 'CacheRecoveryLengthMismatch', 409);
      await withinBudget(() => writer.write(chunk.value));
    }
    requireThat(bytes === entry.sizeBytes, 'CacheRecoveryLengthMismatch', 409);
    await withinBudget(() => writer.close());
    const computed = Array.from(new Uint8Array(await withinBudget(() => hasher.digest)), n => n.toString(16).padStart(2, '0')).join('');
    requireThat(computed === entry.sha256, 'CacheRecoveryDigestMismatch', 409);
  } catch (error) { reader.cancel().catch(() => {}); writer.abort(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
