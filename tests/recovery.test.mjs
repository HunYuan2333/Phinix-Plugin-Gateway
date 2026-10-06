import test from 'node:test';
import assert from 'node:assert/strict';
import { Trace } from '../src/audit.mjs';
import { cacheEntry } from '../src/cache-ledger.mjs';
import { coordinator, cacheConfig, cacheRequest, traceCapture, digestFactory, encode, sha } from './helpers.mjs';
import bridge from '../ops/local-bridge.mjs';
const bytes=encode('recoverable immutable bytes'),entry={source:'test.local',package:'a',version:'1.0.0',sha256:sha(bytes),sizeBytes:bytes.length},key=cacheEntry(entry).key;
const input=c=>({schemaVersion:1,epoch:c.core.config.epoch,period:c.core.config.period});
async function setup(extra={}) {
  let now=Date.now();const capture=traceCapture(),c=coordinator({config:{...cacheConfig(now),...extra},now:()=>now,sink:capture.sink});
  c.capture=capture;c.advance=delta=>{now+=delta;};c.core.env.CACHE_OPERATIONS_ENABLED='true';c.core.operations.digestFactory=digestFactory;
  c.bucket.putAfterCommitReject=true;assert.equal((await c.core.fetch(cacheRequest('put',entry,bytes))).status,503);c.bucket.putAfterCommitReject=false;
  c.advance(31000);return c;
}
async function plan(c) {const inspect=await c.core.operations.run('inspect',input(c));assert(inspect.ok);const row=inspect.result.objects[0];return {...input(c),entry,lease:row.entry.lease,fingerprint:row.fingerprint};}
async function confirm(c,p=undefined){return c.core.operations.run('confirm',p??await plan(c));}

test('inspection is bounded, atomic and makes no R2 call or ledger change',async()=>{
 const c=await setup(),before=c.core.ledger.meta(),calls=c.bucket.calls.length;const result=await c.core.operations.run('inspect',input(c));
 assert(result.ok);assert.equal(result.result.objects[0].entry.state,'uncertain');assert.equal(result.result.objects[0].fingerprint.length,64);assert(result.result.journal.length<=64);assert.deepEqual(c.core.ledger.meta(),before);assert.equal(c.bucket.calls.length,calls);
});
test('recovery disabled or wrong epoch/period cannot access bucket',async()=>{
 const c=await setup(),p=await plan(c),calls=c.bucket.calls.length;c.core.env.CACHE_OPERATIONS_ENABLED='false';assert.equal((await confirm(c,p)).code,'CacheOperationsDisabled');c.core.env.CACHE_OPERATIONS_ENABLED='true';
 for(const fields of [{epoch:'wrong'},{period:'wrong'}])assert.equal((await confirm(c,{...p,...fields})).code,'CacheRecoveryTargetMismatch');assert.equal(c.bucket.calls.length,calls);
});
test('lost put acknowledgment recovers reads but retains reservation and historical counters',async()=>{
 const c=await setup(),total=c.core.ledger.totals();const result=await confirm(c);assert(result.ok);assert.equal(result.result.state,'verified');assert.equal(result.result.capacityReleased,false);assert.deepEqual(result.result.totals,total);
 assert.equal(c.core.ledger.meta().classA,3);assert.equal(c.core.ledger.meta().classB,1);assert.equal(c.core.ledger.entry(key).state,'verified');assert.deepEqual(c.core.ledger.evictionCandidates({...entry,version:'2.0.0'}),[]);
 const hit=await c.core.fetch(cacheRequest('get',entry));assert.equal(hit.status,200);assert.deepEqual(new Uint8Array(await hit.arrayBuffer()),bytes);assert.equal(c.core.ledger.meta().classB,2);assert.equal(c.core.ledger.totals().reservedBytes,bytes.length+2048);
 assert(c.capture.records.some(r=>r.event==='cache.recovery_confirmed'));const persisted=c.core.ledger.sql.exec("SELECT request_id,value FROM audit WHERE event='cache.recovery_confirmed'").one();assert.equal(JSON.parse(persisted.value).reservedBytes,bytes.length+2048);
});
test('expired writing retained by SQL outage can also recover without resetting ledger',async()=>{
 const c=await setup();const row=c.core.ledger.entry(key);row.state='writing';c.core.ledger.set(row);const before=c.core.ledger.totals();assert((await confirm(c)).ok);assert.deepEqual(c.core.ledger.totals(),before);
});
test('duplicate confirmation and replacement put remain blocked',async()=>{
 const c=await setup(),p=await plan(c);assert((await confirm(c,p)).ok);const calls=c.bucket.calls.length;assert.equal((await confirm(c,p)).code,'CacheRecoveryStateMismatch');assert.equal((await c.core.fetch(cacheRequest('put',entry,bytes))).status,409);assert.equal(c.bucket.calls.length,calls);
});
test('old writer completion cannot downgrade or evict a recovered object',async()=>{
 const c=await setup(),p=await plan(c);assert((await confirm(c,p)).ok);const trace=new Trace({sink:c.capture.sink});assert.throws(()=>c.core.ledger.complete(key,p.lease,trace));c.core.ledger.uncertain(key,p.lease,trace,'CacheLeaseExpired');assert.equal(c.core.ledger.entry(key).state,'verified');assert(c.capture.records.some(r=>r.event==='cache.fill_late_result_ignored'));
});
test('missing object is not proof that uncertain reserved bytes can be released',async()=>{
 const c=await setup(),total=c.core.ledger.totals();c.bucket.objects.delete(key);assert.equal((await confirm(c)).code,'CacheRecoveryObjectMissing');assert.deepEqual(c.core.ledger.totals(),total);assert.equal(c.core.ledger.entry(key).state,'uncertain');assert.equal(c.core.ledger.meta().classB,1);
});
for(const fault of ['size','checksum','metadata','body'])test('recovery refuses '+fault+' without freeing capacity',async()=>{
 const c=await setup(),stored=c.bucket.objects.get(key),total=c.core.ledger.totals();
 if(fault==='size')stored.size++;
 if(fault==='checksum')stored.checksums.sha256=new Uint8Array(32).buffer;
 if(fault==='metadata')stored.customMetadata.source='other.source';
 if(fault==='body'){stored.bytes=stored.bytes.slice();stored.bytes[0]^=1;}
 const result=await confirm(c);assert.equal(result.code,fault==='body'?'CacheRecoveryDigestMismatch':'CacheRecoveryObjectMismatch');assert.deepEqual(c.core.ledger.totals(),total);assert.equal(c.core.ledger.entry(key).state,'uncertain');assert(!c.capture.records.some(r=>r.event==='cache.recovery_confirmed'));
});
test('SQL confirmation failure never emits committed recovery and preserves bytes/counters',async()=>{
 const c=await setup(),total=c.core.ledger.totals();c.storage.failEvent='cache.recovery_confirmed';const result=await confirm(c);assert(!result.ok);assert.deepEqual(c.core.ledger.totals(),total);assert.equal(c.core.ledger.entry(key).state,'uncertain');assert.equal(c.core.ledger.meta().classB,1);assert(!c.capture.records.some(r=>r.event==='cache.recovery_confirmed'));assert(c.capture.records.some(r=>r.event==='cache.recovery_bytes_verified'));
});
test('stale inspection, wrong identity/lease and active writes fail before precharge',async()=>{
 const c=await setup(),p=await plan(c),calls=c.bucket.calls.length;
 for(const fields of [{fingerprint:'f'.repeat(64)},{lease:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},{entry:{...entry,sizeBytes:bytes.length+1}}])assert(!(await confirm(c,{...p,...fields})).ok);
 c.core.active.add(key);assert.equal((await confirm(c,p)).code,'CacheRecoveryActiveWrite');assert.equal(c.bucket.calls.length,calls);assert.equal(c.core.ledger.meta().classB,0);
});
test('unexpired lease and exhausted read budget block recovery before R2 get',async()=>{
 const c=await setup({classB:1});c.advance(-31000);assert.equal((await confirm(c)).code,'CacheRecoveryLeaseNotExpired');c.advance(31000);c.core.ledger.spend('B',new Trace({sink:()=>{}}));const calls=c.bucket.calls.length;assert.equal((await confirm(c)).code,'CacheBudgetExceeded');assert.equal(c.bucket.calls.length,calls);
});
test('expired period remains inspectable but cannot spend or confirm',async()=>{
 const c=await setup(),p=await plan(c),calls=c.bucket.calls.length;c.advance(3600000);assert((await c.core.operations.run('inspect',input(c))).ok);assert.equal((await confirm(c,p)).code,'CacheLedgerPeriodMismatch');assert.equal(c.bucket.calls.length,calls);
});
test('period expiry during verification retains uncertainty and the spent read',async()=>{
 const c=await setup(),get=c.bucket.get.bind(c.bucket);c.bucket.get=async k=>{const result=await get(k);c.advance(3600000);return result;};assert.equal((await confirm(c)).code,'CacheLedgerPeriodMismatch');assert.equal(c.core.ledger.entry(key).state,'uncertain');assert.equal(c.core.ledger.meta().classB,1);
});
test('concurrent confirms perform one precharged read and CAS protects changed state',async()=>{
 const c=await setup(),p=await plan(c),get=c.bucket.get.bind(c.bucket);let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 c.bucket.get=async k=>{entered();await wait;return get(k);};const first=confirm(c,p);await started;assert.equal((await confirm(c,p)).code,'CacheRecoveryInProgress');release();assert((await first).ok);assert.equal(c.core.ledger.meta().classB,1);
 const other=await setup(),otherGet=other.bucket.get.bind(other.bucket);other.bucket.get=async k=>{const result=await otherGet(k),row=other.core.ledger.entry(key);row.expires++;other.core.ledger.set(row);return result;};assert.equal((await confirm(other)).code,'CacheRecoveryInspectionStale');assert.equal(other.core.ledger.entry(key).state,'uncertain');
});
test('paused ledger remains paused after an object is verified',async()=>{
 const c=await setup();c.core.ledger.pause(new Trace({sink:()=>{}}),'StoredObjectMismatch');assert((await confirm(c)).ok);assert.equal(c.core.ledger.meta().status,'paused');assert.equal((await c.core.fetch(cacheRequest('get',entry))).status,503);
});
test('local bridge refuses public hosts, browser origin, unknown action and malformed JSON',async()=>{
 let calls=0;const env={REPOSITORY_OPERATIONS:{inspect:async()=>{calls++;return {ok:true,status:200};}}};
 for(const request of [new Request('https://example.com/operations'),new Request('http://127.0.0.1:18787/operations',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'}),new Request('http://127.0.0.1:18787/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"purge","input":{}}'}),new Request('http://127.0.0.1:18787/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"inspect","action":"confirm","input":{}}'})])assert((await bridge.fetch(request,env)).status>=400);assert.equal(calls,0);
});
test('late R2 get after timeout is cancelled and cannot confirm or release bytes',async()=>{
 const c=await setup(),p=await plan(c);c.core.operations.idleMs=10;let release,cancelled=false;
 c.bucket.get=()=>new Promise(resolve=>release=()=>resolve({body:new ReadableStream({cancel(){cancelled=true;}})}));
 assert.equal((await confirm(c,p)).code,'CacheRecoveryReadTimeout');assert.equal(c.core.ledger.meta().classB,1);assert.equal(c.core.ledger.entry(key).state,'uncertain');assert.equal(c.core.operations.recovering.size,0);
 release();await new Promise(resolve=>setTimeout(resolve,0));assert(cancelled);
});
test('hung body is cancelled; total deadline also covers digest close',async()=>{
 const c=await setup(),get=c.bucket.get.bind(c.bucket);c.core.operations.idleMs=10;let cancelled=false;
 c.bucket.get=async k=>({...await get(k),body:new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}})});
 assert.equal((await confirm(c)).code,'CacheRecoveryReadTimeout');assert(cancelled);assert.equal(c.core.ledger.entry(key).state,'uncertain');
 const other=await setup();other.core.operations.totalMs=1;const factory=digestFactory;other.core.operations.digestFactory=()=>{const stream=factory(),writer=stream.getWriter.bind(stream);stream.getWriter=()=>{const actual=writer();return {write:async chunk=>{await actual.write(chunk);other.advance(2);},close:()=>actual.close(),abort:error=>actual.abort(error)};};return stream;};
 assert.equal((await confirm(other)).code,'CacheRecoveryReadTimeout');assert.equal(other.core.ledger.entry(key).state,'uncertain');
});
test('local bridge serializes strict null-prototype input for internal RPC',async()=>{
 let calls=0;const env={REPOSITORY_OPERATIONS:{inspect:async input=>{calls++;assert.equal(Object.getPrototypeOf(input),Object.prototype);return {schemaVersion:1,ok:true,requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',result:{}};}}};
 const response=await bridge.fetch(new Request('http://127.0.0.1:18787/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'inspect',input:{schemaVersion:1,epoch:'test-cache-v1',period:'test-period'}})}),env);assert.equal(response.status,200);assert.equal(calls,1);
});
test('failed recovery read reservation commits no counter and makes no R2 get',async()=>{
 const c=await setup(),p=await plan(c),calls=c.bucket.calls.length,total=c.core.ledger.totals();c.storage.failEvent='cache.recovery_read_reserved';
 assert(!(await confirm(c,p)).ok);assert.equal(c.bucket.calls.length,calls);assert.equal(c.core.ledger.meta().classB,0);assert.deepEqual(c.core.ledger.totals(),total);assert.equal(c.core.operations.recovering.size,0);
 assert(!c.capture.records.some(r=>r.event==='cache.recovery_read_reserved'));
});
test('short body and oversized input chunks cannot commit recovery',async()=>{
 for(const fault of ['short','chunk']) {
  const c=await setup(),get=c.bucket.get.bind(c.bucket),total=c.core.ledger.totals();
  c.bucket.get=async k=>({...await get(k),body:new ReadableStream({start(controller){controller.enqueue(fault==='short'?bytes.subarray(1):new Uint8Array(1024*1024+1));controller.close();}})});
  assert.equal((await confirm(c)).code,fault==='short'?'CacheRecoveryLengthMismatch':'CacheRecoveryChunkLimit');assert.deepEqual(c.core.ledger.totals(),total);assert.equal(c.core.ledger.entry(key).state,'uncertain');assert.equal(c.core.ledger.meta().classB,1);
 }
});
test('bridge RPC timeout has a correlated stage and no late success claim',async()=>{
 const {createOperationsBridge}=await import('../ops/local-bridge.mjs');const records=[];let resolve;
 const local=createOperationsBridge({rpcTimeoutMs:5,sink:line=>records.push(JSON.parse(line))});
 const env={REPOSITORY_OPERATIONS:{confirmRecovery:()=>new Promise(r=>resolve=r)}};
 const response=await local.fetch(new Request('http://127.0.0.1:18787/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'confirm',input:{schemaVersion:1,epoch:'test-cache-v1',period:'test-period'}})}),env);
 assert.equal(response.status,503);const error=await response.json();assert.equal(error.code,'OperationsRpcTimeout');assert.equal(error.retryable,false);assert.equal(response.headers.get('X-Phinix-Request-Id'),error.requestId);
 assert(records.some(r=>r.event==='operations.rpc_started'&&r.stage==='confirm'));resolve({ok:true});await new Promise(r=>setTimeout(r,0));assert(!records.some(r=>r.event==='operations.rpc_completed'));assert.equal(records.filter(r=>r.event==='request.complete').length,1);
});
