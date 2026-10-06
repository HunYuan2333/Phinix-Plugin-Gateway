import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginMetadataCache } from '../src/origin-metadata-cache.mjs';
import { createGateway } from '../src/gateway.mjs';
import { fixture, mockGithub, testEnv, context, traceCapture, encode, digestFactory, coordinator, sha } from './helpers.mjs';
const root='https://repo.example.test/v1/sources/test.local';
test('metadata shares concurrent success; copied bytes cannot mutate cache',async()=>{
  let release,calls=0,now=1;const capture=traceCapture(),cache=new OriginMetadataCache({now:()=>now}),trace={event:()=>{}};
  const load=async()=>{calls++;await new Promise(r=>release=r);return encode('okay');};
  const a=cache.read('key',30000,load,trace),b=cache.read('key',30000,load,trace);release();const [first,second]=await Promise.all([a,b]);assert.equal(calls,1);first.bytes[0]=0;
  assert.equal(new TextDecoder().decode(second.bytes),'okay');const third=await cache.read('key',30000,load,trace);assert.equal(new TextDecoder().decode(third.bytes),'okay');assert.equal(calls,1);
});
test('expired metadata never serves stale when new lookup fails',async()=>{
  let now=0,calls=0;const cache=new OriginMetadataCache({now:()=>now}),trace={event:()=>{}};
  await cache.read('key',10,async()=>encode('old'),trace);now=10;
  const load=async()=>{calls++;throw Error('rate limited');};await assert.rejects(cache.read('key',10,load,trace));await assert.rejects(cache.read('key',10,load,trace));assert.equal(calls,2);assert.equal(cache.entries.size,0);assert.equal(cache.inflight.size,0);
});
test('entry count, aggregate size, single entry and slow-fill bounds',async()=>{
  let now=0;const cache=new OriginMetadataCache({now:()=>now,maxEntries:2,maxBytes:6,maxEntryBytes:4}),trace={event:()=>{}};
  for(const key of ['a','b','c'])await cache.read(key,10,async()=>encode(key.repeat(3)),trace);assert.equal(cache.entries.size,2);assert.equal(cache.bytes,6);assert(!cache.entries.has('a'));
  await cache.read('large',10,async()=>encode('large'),trace);assert(!cache.entries.has('large'));
  await cache.read('slow',10,async()=>{now=11;return encode('x');},trace);assert(!cache.entries.has('slow'));assert.equal(cache.inflight.size,0);
});
test('inflight bookkeeping is bounded even across many keys',async()=>{
  const cache=new OriginMetadataCache({maxInflight:2}),trace={event:()=>{}},releases=[];
  const loads=Array.from({length:8},(_,i)=>cache.read(String(i),30000,()=>new Promise(resolve=>releases.push(()=>resolve(encode('x')))),trace));assert.equal(cache.inflight.size,2);releases.forEach(r=>r());await Promise.all(loads);assert.equal(cache.inflight.size,0);
});
test('warm R2 plus bounded approved metadata makes no GitHub calls; fresh bypass rechecks',async()=>{
  const data=await fixture(),capture=traceCapture(),cache=coordinator({sink:capture.sink}),mock=mockGithub(data),worker=createGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory,cachePipeFactory:()=>new TransformStream()}),env=testEnv({R2_ENABLED:'true',CACHE_COORDINATOR:cache.binding,ORIGIN_METADATA_CACHE_SECONDS:'30'}),ctx=context();
  const path=`${root}/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`;
  assert.deepEqual(new Uint8Array(await(await worker.fetch(new Request(path),env,ctx)).arrayBuffer()),data.payload);await ctx.flush();mock.calls.length=0;
  assert.deepEqual(new Uint8Array(await(await worker.fetch(new Request(path),env,context())).arrayBuffer()),data.payload);assert.equal(mock.calls.length,0);assert(capture.records.some(r=>r.event==='origin.metadata_hit'));
  const fresh=await worker.fetch(new Request(path,{headers:{'Cache-Control':'no-cache'}}),env,context());assert.deepEqual(new Uint8Array(await fresh.arrayBuffer()),data.payload);assert(mock.calls.length>0);assert(capture.records.some(r=>r.event==='origin.metadata_bypass'));
});
test('short metadata expiry rejects unavailable approval instead of delivering warm R2',async()=>{
  let now=Date.now(),fail=false;const data=await fixture(),capture=traceCapture(),mock=mockGithub(data),worker=createGateway({now:()=>now,sink:capture.sink,fetcher:async(...args)=>fail?new Response(null,{status:403}):mock.fetcher(...args)}),env=testEnv({ORIGIN_METADATA_CACHE_SECONDS:'1'});
  assert.equal((await worker.fetch(new Request(root+'/stable'),env,context())).status,200);fail=true;now+=1001;
  const result=await worker.fetch(new Request(root+'/stable'),env,context());assert.equal(result.status,503);assert.equal((await result.json()).code,'OriginRateLimited');
});
test('credential scopes isolate cache and freshness age remains visible',async()=>{
  let now=Date.now();const data=await fixture(),capture=traceCapture(),mock=mockGithub(data),worker=createGateway({now:()=>now,fetcher:mock.fetcher,sink:capture.sink}),env=testEnv({ORIGIN_METADATA_CACHE_SECONDS:'30'});
  assert.equal((await worker.fetch(new Request(root+'/stable'),env,context())).status,200);mock.calls.length=0;now+=1001;
  const hit=await worker.fetch(new Request(root+'/stable'),env,context());assert.equal(hit.headers.get('Age'),'2');assert.equal(mock.calls.length,0);
  assert.equal((await worker.fetch(new Request(root+'/stable'),{...env,GITHUB_TOKEN:'OTHER_SECRET'},context())).status,200);assert(mock.calls.length>0);assert(!JSON.stringify(capture.records).includes('OTHER_SECRET'));
});
test('invalid metadata TTL fails closed before origin',async()=>{
  let calls=0;const worker=createGateway({sink:()=>{},fetcher:()=>{calls++;}});
  for(const value of ['301','-1','1.5','SECRET'])assert.equal((await worker.fetch(new Request(root+'/stable'),testEnv({ORIGIN_METADATA_CACHE_SECONDS:value}),context())).status,503);assert.equal(calls,0);
});
