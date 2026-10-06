import { GatewayError } from './audit.mjs';
import { identifier, hex, size, version, object, strictJson, requireThat, MAX_PACKAGE } from './protocol.mjs';

export function cacheEntry(value) {
  object(value, ['source', 'package', 'version', 'sha256', 'sizeBytes']);
  identifier(value.source); identifier(value.package); version(value.version); hex(value.sha256); size(value.sizeBytes, MAX_PACKAGE);
  return { ...value, key: `${value.source}/packages/${value.package}/${value.version}/${value.sha256}/package` };
}
const compareVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
export class CacheLedger {
  constructor(storage, config, now = Date.now) {
    this.storage = storage; this.sql = storage.sql; this.config = config; this.now = now;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, event TEXT NOT NULL, time INTEGER NOT NULL, value TEXT NOT NULL)');
    if (this.sql.exec('SELECT value FROM meta WHERE id=1').toArray().length === 0)
      this.sql.exec('INSERT INTO meta(id,value) VALUES(1,?)', JSON.stringify({ schemaVersion: 1, status: 'uninitialized', classA: 0, classB: 0, period: config.period, start: config.start, end: config.end, epoch: config.epoch }));
  }
  transaction(trace, action) {
    requireThat(!this.pending, 'NestedLedgerTransaction', 503);
    const events = []; this.pending = events; let result;
    try { result = this.storage.transactionSync(action); }
    finally { this.pending = null; }
    for (const item of events) trace.event(item.event, item.fields);
    return result;
  }
  meta() { return JSON.parse(this.sql.exec('SELECT value FROM meta WHERE id=1').one().value); }
  setMeta(meta) { this.sql.exec('UPDATE meta SET value=? WHERE id=1', JSON.stringify(meta)); }
  entries() { return this.sql.exec('SELECT value FROM objects ORDER BY key LIMIT 257').toArray().map(r => JSON.parse(r.value)); }
  entry(key) { const rows = this.sql.exec('SELECT value FROM objects WHERE key=?', key).toArray(); return rows.length ? JSON.parse(rows[0].value) : null; }
  set(entry) { this.sql.exec('INSERT INTO objects(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', entry.key, JSON.stringify(entry)); }
  audit(trace, event, fields = {}) {
    this.sql.exec('INSERT INTO audit(request_id,event,time,value) VALUES(?,?,?,?)', trace.id, event, this.now(), JSON.stringify({ ...trace.base, spanId: trace.spanId, ...fields }));
    this.sql.exec('DELETE FROM audit WHERE seq <= (SELECT COALESCE(MAX(seq),0)-256 FROM audit)');
    if (this.pending) this.pending.push({ event, fields }); else trace.event(event, fields);
  }
  assertPeriod(meta) {
    requireThat(meta.schemaVersion === 1 && meta.epoch === this.config.epoch && meta.period === this.config.period && meta.start === this.config.start && meta.end === this.config.end && this.now() >= meta.start && this.now() < meta.end, 'CacheLedgerPeriodMismatch', 503);
  }
  check(meta) { this.assertPeriod(meta); requireThat(meta.status === 'ready', 'CacheLedgerUnavailable', 503); }
  beginBootstrap(trace) {
    return this.transaction(trace, () => {
      const meta = this.meta(); this.assertPeriod(meta); requireThat(meta.status === 'uninitialized' && this.config.emptyConfirmed === true, 'CacheBootstrapRequired', 503);
      requireThat(this.config.classA >= 2 && this.config.capacity >= 8192, 'CacheBudgetExceeded', 503);
      meta.status = 'initializing'; meta.classA += 2;
      this.setMeta(meta); this.audit(trace, 'cache.bootstrap_started', { classA: meta.classA, period: meta.period });
    });
  }
  finishBootstrap(empty, trace) {
    this.transaction(trace, () => { const meta = this.meta(); meta.status = empty ? 'ready' : 'paused'; this.setMeta(meta); this.audit(trace, empty ? 'cache.bootstrap_complete' : 'cache.bootstrap_rejected', { reason: empty ? 'ConfirmedEmptyBucket' : 'ExistingBucketObjects' }); });
  }
  pause(trace, reason) {
    this.transaction(trace, () => { const meta = this.meta(); meta.status = 'paused'; this.setMeta(meta); this.audit(trace, 'cache.paused', { reason }); });
  }
  spend(kind, trace) {
    this.transaction(trace, () => {
      const meta = this.meta(); this.check(meta); const key = kind === 'A' ? 'classA' : 'classB';
      requireThat(meta[key] < this.config[key], 'CacheBudgetExceeded', 503);
      meta[key]++; this.setMeta(meta); this.audit(trace, 'cache.budget_spent', { classA: meta.classA, classB: meta.classB, stage: kind });
    });
  }
  totals() {
    const entries = this.entries(); requireThat(entries.length <= 256, 'CacheLedgerRowLimit', 503);
    return { usedBytes: 4096 + entries.filter(e => e.state === 'ready').reduce((n, e) => n + e.sizeBytes + 2048, 0),
      reservedBytes: entries.filter(e => e.state !== 'ready').reduce((n, e) => n + e.sizeBytes + 2048, 0), rows: entries.length };
  }
  reserve(entry, trace) {
    return this.transaction(trace, () => {
      const meta = this.meta(); this.check(meta); const totals = this.totals();
      requireThat(!this.entry(entry.key), 'CacheFillAlreadyTracked', 409);
      requireThat(meta.classA < this.config.classA && meta.classB < this.config.classB, 'CacheBudgetExceeded', 503);
      requireThat(totals.rows < 256 && totals.usedBytes + totals.reservedBytes + entry.sizeBytes + 2048 <= this.config.capacity, 'CacheCapacityExceeded', 409);
      const lease = crypto.randomUUID();
      meta.classA++; this.setMeta(meta);
      this.set({ ...entry, state: 'writing', lease, expires: this.now() + 30000 });
      this.audit(trace, 'cache.fill_reserved', { ...this.totals(), lease, expectedBytes: entry.sizeBytes, classA: meta.classA, classB: meta.classB }); return lease;
    });
  }
  complete(key, lease, trace) {
    this.transaction(trace, () => {
      this.check(this.meta());
      const entry = this.entry(key); requireThat(entry?.lease === lease && entry.state === 'writing', 'CacheLeaseMismatch', 503);
      requireThat(this.now() < entry.expires, 'CacheLeaseExpired', 503);
      entry.state = 'ready'; this.set(entry); this.audit(trace, 'cache.fill_committed', { lease, ...this.totals() });
    });
  }
  uncertain(key, lease, trace, reason) {
    this.transaction(trace, () => {
      const entry = this.entry(key); if (!entry || entry.lease !== lease) return;
      if (!['writing', 'uncertain'].includes(entry.state)) { this.audit(trace, 'cache.fill_late_result_ignored', { lease, reason, state: entry.state }); return; }
      entry.state = 'uncertain'; this.set(entry); this.audit(trace, 'cache.fill_uncertain', { lease, reason, ...this.totals() });
      // Expiry/failure never releases bytes or permits another put to this key.
    });
  }
  reserveRecoveryRead(key, expected, trace) {
    this.transaction(trace, () => {
      const meta = this.meta(); this.assertPeriod(meta);
      requireThat(['ready', 'paused'].includes(meta.status), 'CacheLedgerUnavailable', 503);
      requireThat(JSON.stringify(this.entry(key)) === expected, 'CacheRecoveryInspectionStale', 409);
      requireThat(meta.classB < this.config.classB, 'CacheBudgetExceeded', 503);
      meta.classB++; this.setMeta(meta);
      this.audit(trace, 'cache.recovery_read_reserved', { classA: meta.classA, classB: meta.classB, ...this.totals() });
    });
  }
  confirmRecovery(key, expected, trace) {
    this.transaction(trace, () => {
      this.assertPeriod(this.meta());
      const entry = this.entry(key); requireThat(JSON.stringify(entry) === expected, 'CacheRecoveryInspectionStale', 409);
      entry.state = 'verified'; entry.verifiedAt = this.now(); entry.recoveryRequestId = trace.id;
      this.set(entry); this.audit(trace, 'cache.recovery_confirmed', { state: entry.state, ...this.totals() });
      // Readable but still reserved and non-evictable: late writers are not proven quiescent.
    });
  }
  evictionCandidates(incoming) {
    const entries = this.entries().filter(e => e.state === 'ready');
    return entries.filter(e => entries.some(other => other.source === e.source && other.package === e.package && compareVersion(other.version, e.version) > 0) ||
      (incoming.source === e.source && incoming.package === e.package && compareVersion(incoming.version, e.version) > 0))
      .sort((a, b) => compareVersion(a.version, b.version) || a.key.localeCompare(b.key));
  }
  beginDelete(key, trace) {
    this.transaction(trace, () => { const meta = this.meta(); this.check(meta); const entry = this.entry(key); requireThat(entry?.state === 'ready', 'CacheDeleteConflict', 409); entry.state = 'deleting'; this.set(entry); this.audit(trace, 'cache.delete_started', { ...this.totals() }); });
  }
  finishDelete(key, trace) {
    this.transaction(trace, () => { requireThat(this.entry(key)?.state === 'deleting', 'CacheDeleteConflict', 409); this.sql.exec('DELETE FROM objects WHERE key=?', key); this.audit(trace, 'cache.delete_committed', { ...this.totals() }); });
  }
}
export function cacheConfig(env) {
  const c = typeof env.CACHE_CONFIG === 'string' ? strictJson(new TextEncoder().encode(env.CACHE_CONFIG)) : env.CACHE_CONFIG;
  object(c, ['epoch', 'period', 'start', 'end', 'capacity', 'classA', 'classB', 'emptyConfirmed', 'maxFillBytes']);
  requireThat(typeof c.epoch === 'string' && /^[a-z0-9-]{1,64}$/.test(c.epoch) && typeof c.period === 'string' && /^[a-z0-9-]{1,64}$/.test(c.period), 'InvalidCacheConfiguration', 503);
  requireThat(Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end) && c.start < c.end, 'InvalidCacheConfiguration', 503);
  size(c.capacity, 9000000000); size(c.classA, 800000); size(c.classB, 8000000); size(c.maxFillBytes, 8 * 1024 * 1024);
  requireThat(typeof c.emptyConfirmed === 'boolean', 'InvalidCacheConfiguration', 503); return c;
}
