import test from 'node:test';
import assert from 'node:assert/strict';
import {CacheCoordinatorCore} from '../src/cache-coordinator.mjs';
import {sqliteStorage,Bucket,cacheConfig,cacheRequest,sha} from './helpers.mjs';
const oct=Date.UTC(2026,9,15),nov=Date.UTC(2026,10,1),bytes=new Uint8Array([1,2,3]);
const entry={source:'test.local',package:'a',version:'1.0.0',sha256:sha(bytes),sizeBytes:bytes.length};
for(const restart of [false,true])test('explicit UTC monthly counters rotate without resetting objects; restart='+restart,async()=>{
 let now=oct;const storage=sqliteStorage(),bucket=new Bucket(),env={CACHE_CONFIG:cacheConfig(oct),CACHE_BUDGET_WINDOW:'utc-month',PACKAGES:bucket};
 let core=new CacheCoordinatorCore(storage,env,{now:()=>now,sink:()=>{}});
 assert.equal((await core.fetch(cacheRequest('put',entry,bytes))).status,201);assert.equal(core.ledger.meta().classA,3);
 const lease=core.ledger.entry(core.ledger.entries()[0].key).lease;
 now=nov;if(restart)core=new CacheCoordinatorCore(storage,env,{now:()=>now,sink:()=>{}});
 const response=await core.fetch(cacheRequest('get',entry));assert.equal(response.status,200);await response.arrayBuffer();
 assert.equal(core.ledger.meta().period,'2026-11');assert.equal(core.ledger.meta().classA,0);assert.equal(core.ledger.meta().classB,1);assert.equal(core.ledger.entries()[0].lease,lease);
});
test('monthly rotation preserves paused status and uncertain capacity, and rejects clock rollback',async()=>{
 let now=oct;const storage=sqliteStorage(),bucket=new Bucket(),env={CACHE_CONFIG:cacheConfig(oct),CACHE_BUDGET_WINDOW:'utc-month',PACKAGES:bucket};
 const core=new CacheCoordinatorCore(storage,env,{now:()=>now,sink:()=>{}});
 await core.fetch(cacheRequest('put',entry,bytes));const item=core.ledger.entries()[0];item.state='uncertain';core.ledger.set(item);const meta=core.ledger.meta();meta.status='paused';core.ledger.setMeta(meta);const totals=core.ledger.totals();
 now=nov;assert.equal((await core.fetch(cacheRequest('get',entry))).status,503);assert.equal(core.ledger.meta().status,'paused');assert.deepEqual(core.ledger.totals(),totals);assert.equal(core.ledger.entries()[0].state,'uncertain');
 now=oct;assert.equal((await core.fetch(cacheRequest('get',entry))).status,503);assert.equal(core.ledger.meta().period,'2026-11');
});
