import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheCoordinatorCore } from '../src/cache-coordinator.mjs';
import { CacheLedger, cacheEntry } from '../src/cache-ledger.mjs';
import { Trace } from '../src/audit.mjs';
import { coordinator, cacheConfig, sqliteStorage, Bucket, cacheRequest, traceCapture, encode, sha } from './helpers.mjs';
const bytes=encode('cache payload'), entry=(v='1.0.0',pkg='a')=>({source:'test.local',package:pkg,version:v,sha256:sha(bytes),sizeBytes:bytes.length});
const put=(c,e=entry())=>c.core.fetch(cacheRequest('put',e,bytes));

test('reservation audit reports committed occupied bytes before the R2 write',async()=>{
  const capture=traceCapture(),c=coordinator({sink:capture.sink});
  c.bucket.beforePut=async()=>{
    const reserved=capture.records.find(r=>r.event==='cache.fill_reserved');assert(reserved);
    assert.equal(reserved.usedBytes,4096);assert.equal(reserved.reservedBytes,bytes.length+2048);assert.equal(reserved.rows,1);
    const persisted=JSON.parse(c.storage.sql.exec("SELECT value FROM audit WHERE event='cache.fill_reserved'").one().value);
    assert.equal(persisted.reservedBytes,reserved.reservedBytes);assert.equal(persisted.lease,reserved.lease);
  };
  assert.equal((await put(c)).status,201);
  const committed=capture.records.find(r=>r.event==='cache.fill_committed');assert.equal(committed.reservedBytes,0);
});

test('private cache requires explicit empty bucket bootstrap; no calls without confirmation',async()=>{
  const capture=traceCapture(),config={...cacheConfig(),emptyConfirmed:false},c=coordinator({config,sink:capture.sink});
  assert.equal((await put(c)).status,503);assert.equal(c.bucket.calls.length,0);assert.equal(c.core.ledger.meta().classA,0);
});
test('existing bucket and lost ledger cannot reset history from current object count',async()=>{
  const c=coordinator({sink:()=>{}});assert.equal((await put(c)).status,201);
  const marker=[...c.bucket.objects.keys()].find(key=>key.startsWith('__phinix'));assert(marker);
  c.bucket.objects.delete(cacheEntry(entry()).key);
  const restored=new CacheCoordinatorCore(sqliteStorage(),{CACHE_CONFIG:c.core.config,PACKAGES:c.bucket},{sink:()=>{}});
  const response=await restored.fetch(cacheRequest('put',entry(),bytes));assert.equal(response.status,503);assert.equal(restored.ledger.meta().status,'paused');
  assert.equal(c.bucket.calls.filter(x=>x.startsWith('put:__phinix')).length,1);
});
test('bootstrap interrupted after list never repeats or zeroes spent budget on restart',async()=>{
  const bucket=new Bucket();bucket.list=async()=>{bucket.calls.push('list');throw Error('lost list response');};
  const c=coordinator({bucket,sink:()=>{}});assert.equal((await put(c)).status,503);assert.equal(c.core.ledger.meta().classA,2);
  const restarted=new CacheCoordinatorCore(c.storage,{CACHE_CONFIG:c.core.config,PACKAGES:bucket},{sink:()=>{}});
  assert.equal((await restarted.fetch(cacheRequest('put',entry(),bytes))).status,503);assert.deepEqual(bucket.calls,['list']);
});
test('concurrent same-key fills reserve once and never duplicate a put',async()=>{
  const capture=traceCapture(),c=coordinator({sink:capture.sink});let release,entered;
  const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);c.bucket.beforePut=async()=>{entered();await wait;};
  const first=put(c);await started;const second=await put(c);assert.equal(second.status,409);
  assert.equal(c.bucket.calls.filter(x=>x==='put:'+cacheEntry(entry()).key).length,1);assert(c.core.ledger.totals().reservedBytes>=bytes.length);release();assert.equal((await first).status,201);
  assert(c.core.ledger.totals().usedBytes<=c.core.config.capacity);assert.equal(c.core.ledger.meta().classA,3);
});
test('put success with lost acknowledgment retains uncertainty and cannot be served/refilled',async()=>{
  const capture=traceCapture(),c=coordinator({sink:capture.sink});c.bucket.putAfterCommitReject=true;
  assert.equal((await put(c)).status,503);const key=cacheEntry(entry()).key;assert(c.bucket.objects.has(key));assert.equal(c.core.ledger.entry(key).state,'uncertain');
  assert.equal((await c.core.fetch(cacheRequest('get',entry()))).status,404);assert.equal((await put(c)).status,409);
  assert.equal(c.bucket.calls.filter(x=>x==='put:'+key).length,1);assert(c.core.ledger.totals().reservedBytes>=bytes.length);assert(!JSON.stringify(capture.records).includes('SECRET'));
});
test('R2 success followed by SQL commit/audit failure never reports committed success',async()=>{
  const capture=traceCapture(),c=coordinator({sink:capture.sink});c.storage.failEvent='cache.fill_committed';
  assert.equal((await put(c)).status,503);assert.equal(c.core.ledger.entry(cacheEntry(entry()).key).state,'uncertain');assert(!capture.records.some(r=>r.event==='cache.fill_committed'));assert(capture.records.some(r=>r.event==='cache.fill_uncertain'));
});
test('permanent SQL outage after put preserves original persistent writing reservation',async()=>{
  const capture=traceCapture(),c=coordinator({sink:capture.sink});const original=c.bucket.put.bind(c.bucket);
  c.bucket.put=async(...args)=>{const result=await original(...args);if(!args[0].startsWith('__phinix'))c.storage.failWrites=true;return result;};
  assert.equal((await put(c)).status,503);assert.equal(c.core.ledger.entry(cacheEntry(entry()).key).state,'writing');assert(capture.records.some(r=>r.event==='cache.ledger_commit_unknown'));
  c.storage.failWrites=false;const resumed=new CacheCoordinatorCore(c.storage,{CACHE_CONFIG:c.core.config,PACKAGES:c.bucket},{sink:()=>{}});assert.equal((await resumed.fetch(cacheRequest('put',entry(),bytes))).status,409);
});
test('lease expiry does not free bytes or allow a late put to become a hit',async()=>{
  let current=Date.now();const config=cacheConfig(current),c=coordinator({config,now:()=>current,sink:()=>{}});c.bucket.beforePut=async()=>{current+=31000;};
  assert.equal((await put(c)).status,503);const tracked=c.core.ledger.entry(cacheEntry(entry()).key);assert.equal(tracked.state,'uncertain');assert(c.core.ledger.totals().reservedBytes>=bytes.length);assert.equal((await put(c)).status,409);
});
test('A budget exhaustion blocks put before any R2 call',async()=>{
  const c=coordinator({config:{...cacheConfig(),classA:2},sink:()=>{}});assert.equal((await put(c)).status,503);assert.equal(c.bucket.calls.length,2);assert.equal(c.core.ledger.meta().classA,2);assert.equal(c.core.ledger.entries().length,0);
});
test('B exhaustion blocks get and new fills without calling R2',async()=>{
  const c=coordinator({config:{...cacheConfig(),classB:1},sink:()=>{}});assert.equal((await put(c)).status,201);
  const hit=await c.core.fetch(cacheRequest('get',entry()));assert.equal(hit.status,200);await hit.arrayBuffer();const calls=c.bucket.calls.length;
  assert.equal((await c.core.fetch(cacheRequest('get',entry()))).status,503);assert.equal((await put(c,entry('2.0.0'))).status,503);assert.equal(c.bucket.calls.length,calls);
});
test('period change/expiration does not silently reset budgets',async()=>{
  let current=Date.now();const config=cacheConfig(current),c=coordinator({config,now:()=>current,sink:()=>{}});assert.equal((await put(c)).status,201);const calls=c.bucket.calls.length;
  current=config.end;assert.equal((await c.core.fetch(cacheRequest('get',entry()))).status,503);assert.equal(c.bucket.calls.length,calls);
  const changed=new CacheCoordinatorCore(c.storage,{CACHE_CONFIG:{...config,period:'new-period'},PACKAGES:c.bucket},{sink:()=>{},now:()=>config.start+10});
  assert.equal((await changed.fetch(cacheRequest('get',entry()))).status,503);assert.equal(changed.ledger.meta().period,config.period);
});
test('capacity and conservative metadata margin never over-reserve under concurrent keys',async()=>{
  const c=coordinator({config:{...cacheConfig(),capacity:8192},sink:()=>{}});
  const responses=await Promise.all([put(c,entry('1.0.0','a')),put(c,entry('1.0.0','b'))]);assert.equal(responses.filter(r=>r.status===201).length,1);
  const total=c.core.ledger.totals();assert(total.usedBytes+total.reservedBytes<=8192);
});
test('old versions evict only after confirmed deletion, retaining the newer version',async()=>{
  const c=coordinator({config:{...cacheConfig(),capacity:10000},sink:()=>{}});assert.equal((await put(c)).status,201);assert.equal((await put(c,entry('2.0.0'))).status,201);
  assert.equal((await put(c,entry('3.0.0'))).status,201);assert(!c.bucket.objects.has(cacheEntry(entry()).key));assert(c.bucket.objects.has(cacheEntry(entry('3.0.0')).key));assert(c.core.ledger.totals().usedBytes<=10000);
});
test('delete acknowledgment loss retains deleting bytes and refuses incoming fill',async()=>{
  const capture=traceCapture(),c=coordinator({config:{...cacheConfig(),capacity:10000},sink:capture.sink});await put(c);await put(c,entry('2.0.0'));c.bucket.deleteReject=true;
  assert.equal((await put(c,entry('3.0.0'))).status,503);assert.equal(c.core.ledger.entry(cacheEntry(entry()).key).state,'deleting');assert(c.core.ledger.totals().reservedBytes>=bytes.length);assert(!c.bucket.objects.has(cacheEntry(entry('3.0.0')).key));assert(capture.records.some(r=>r.event==='cache.delete_uncertain'));
});
test('stored bytes/checksum mismatch or external deletion pauses ledger operations',async()=>{
  for(const missing of [false,true]){
    const c=coordinator({sink:()=>{}});await put(c);const key=cacheEntry(entry()).key;
    if(missing)c.bucket.objects.delete(key);else c.bucket.objects.get(key).size++;
    assert((await c.core.fetch(cacheRequest('get',entry()))).status>=400);assert.equal(c.core.ledger.meta().status,'paused');const calls=c.bucket.calls.length;assert.equal((await put(c,entry('2.0.0'))).status,503);assert.equal(c.bucket.calls.length,calls);
  }
});
test('persistent audit journal stays bounded and correlates reservation/commit',async()=>{
  const capture=traceCapture(),c=coordinator({sink:capture.sink});await put(c);const trace=new Trace({sink:()=>{}});
  for(let i=0;i<300;i++)c.core.ledger.transaction(trace,()=>c.core.ledger.audit(trace,'test.event',{bytes:i}));
  const rows=c.storage.sql.exec('SELECT * FROM audit ORDER BY seq').toArray();assert.equal(rows.length,256);assert(capture.records.some(r=>r.event==='cache.fill_reserved'&&r.lease));assert(capture.records.some(r=>r.event==='cache.fill_committed'&&r.lease));
});
test('period ending during a put retains reservation and rejects commit',async()=>{
  let time=Date.now();const config=cacheConfig(time),c=coordinator({config,now:()=>time,sink:()=>{}});
  c.bucket.beforePut=async()=>{time=config.end;};assert.equal((await put(c)).status,503);
  assert.equal(c.core.ledger.entry(cacheEntry(entry()).key).state,'uncertain');assert(c.core.ledger.totals().reservedBytes>=bytes.length);
});
test('persistent audit retains package identity and span beside request ID',async()=>{
  const c=coordinator({sink:()=>{}});assert.equal((await put(c)).status,201);
  const row=c.storage.sql.exec("SELECT request_id,value FROM audit WHERE event='cache.fill_committed'").one();const record=JSON.parse(row.value);
  assert.equal(row.request_id,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.equal(record.source,'test.local');assert.equal(record.package,'a');assert.equal(record.sha256,sha(bytes));assert.match(record.spanId,/^[a-f0-9-]{36}$/);
});
