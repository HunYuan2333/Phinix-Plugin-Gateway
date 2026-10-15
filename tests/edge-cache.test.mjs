import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway} from '../src/gateway.mjs';
import {edgeCacheLayer} from '../src/edge-cache.mjs';
import {fixture,mockGithub,testEnv,context,traceCapture,digestFactory,sha,coordinator} from './helpers.mjs';
class Edge {
  constructor(){this.rows=new Map();this.puts=0;this.deletes=0;}
  async match(key){const row=this.rows.get(key.url);return row&&new Response(row.bytes.slice(),{headers:row.headers});}
  async put(key,response){this.rows.set(key.url,{bytes:new Uint8Array(await response.arrayBuffer()),headers:Object.fromEntries(response.headers)});this.puts++;}
  async delete(key){this.deletes++;return this.rows.delete(key.url);}
}
const path=data=>`https://repo.example.test/v1/sources/test.local/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`;
test('verified cold fill -> edge hit; eviction -> R2 hit; no-cache still checks approval',async()=>{
 const data=await fixture(),mock=mockGithub(data),capture=traceCapture(),cache=coordinator({sink:capture.sink}),edge=new Edge();
 const worker=createGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory,edgeCache:edge,cachePipeFactory:()=>new TransformStream()});
 const env=testEnv({R2_ENABLED:'true',EDGE_CACHE_ENABLED:'true',CACHE_COORDINATOR:cache.binding,ORIGIN_METADATA_CACHE_SECONDS:'30'});
 const fetch=async(expectedCache)=>{const ctx=context(),response=await worker.fetch(new Request(path(data),{headers:{'Cache-Control':'no-cache'}}),env,ctx);assert.equal(response.headers.get('X-Phinix-Cache'),expectedCache);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),data.payload);await ctx.flush();};
 await fetch('origin');assert.equal(edge.puts,1);assert(capture.records.some(r=>r.event==='cache.fill_committed'));
 mock.calls.length=0;cache.bucket.calls.length=0;await fetch('edge');assert(!mock.calls.some(c=>c.url.pathname.startsWith('/repos/author/')));assert.equal(cache.bucket.calls.length,0);assert(capture.records.some(r=>r.event==='cache.edge_hit'));
 edge.rows.clear();await fetch('r2');assert(capture.records.some(r=>r.event==='cache.r2_hit'));assert.equal(edge.puts,2);
});
test('withdrawal blocks an existing edge object before any cache lookup',async()=>{
 const active=await fixture(),withdrawn=await fixture({packageState:'withdrawn'}),edge=new Edge();let current=active;
 const worker=createGateway({fetcher:(...args)=>mockGithub(current).fetcher(...args),sink:()=>{},digestFactory,edgeCache:edge});
 const env=testEnv({EDGE_CACHE_ENABLED:'true'});let ctx=context(),response=await worker.fetch(new Request(path(active)),env,ctx);await response.arrayBuffer();await ctx.flush();assert.equal(edge.puts,1);
 current=withdrawn;response=await worker.fetch(new Request(path(active)),env,context());assert.equal(response.status,410);
});
test('corrupt origin never enters edge; corrupt edge cannot deliver complete bytes and is evicted',async()=>{
 const data=await fixture(),wrong=data.payload.slice();wrong[0]^=1;const edge=new Edge();let bad=false;
 const worker=createGateway({fetcher:(...args)=>mockGithub(data,{packageBytes:bad?wrong:data.payload}).fetcher(...args),sink:()=>{},digestFactory,edgeCache:edge});
 const env=testEnv({EDGE_CACHE_ENABLED:'true'});bad=true;let ctx=context(),response=await worker.fetch(new Request(path(data)),env,ctx);await assert.rejects(response.arrayBuffer());await ctx.flush();assert.equal(edge.puts,0);
 bad=false;ctx=context();response=await worker.fetch(new Request(path(data)),env,ctx);await response.arrayBuffer();await ctx.flush();edge.rows.get(path(data)).bytes=wrong;
 ctx=context();response=await worker.fetch(new Request(path(data)),env,ctx);await assert.rejects(response.arrayBuffer());await ctx.flush();assert.equal(edge.rows.size,0);assert.equal(edge.deletes,1);
});
test('edge fill concurrency and size limits bound buffered memory; canceled fill releases its slot',async()=>{
 const edge=new Edge(),layer=edgeCacheLayer(edge,{maxBytes:4,maxConcurrent:1}),trace=traceCapture(),audit={event:()=>{}},ctx=context(),key=new Request('https://cache.example.test/a');
 const expected={sizeBytes:4,sha256:sha(new Uint8Array(4))};const writer=layer.writer(key,expected,audit,ctx);assert(writer);
 assert.equal(layer.writer(key,expected,audit,ctx),null);await writer.abort();assert(layer.writer(key,expected,audit,ctx));
 assert.equal(layer.writer(key,{...expected,sizeBytes:5},audit,ctx),null);
});
test('cache service exceptions do not prevent verified upstream serving',async()=>{
 const data=await fixture(),edge={match:async()=>{throw Error('Unavailable');},put:async()=>{throw Error('Unavailable');},delete:async()=>{throw Error('Unavailable');}};
 const worker=createGateway({fetcher:mockGithub(data).fetcher,sink:()=>{},digestFactory,edgeCache:edge});const ctx=context();
 const response=await worker.fetch(new Request(path(data)),testEnv({EDGE_CACHE_ENABLED:'true'}),ctx);assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),data.payload);await ctx.flush();
});
