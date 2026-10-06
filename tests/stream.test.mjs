import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedStream } from '../src/stream.mjs';
import { boundedBody, GitHubOrigin } from '../src/github.mjs';
import { Trace } from '../src/audit.mjs';
import { digestFactory, encode, sha, traceCapture, fixture, mockGithub, context, testEnv } from './helpers.mjs';
import { createGateway } from '../src/gateway.mjs';
const payload=encode('complete package');
function observe(body,expected={sizeBytes:payload.length,sha256:sha(payload)},options={}){
  const capture=traceCapture(),trace=new Trace({sink:capture.sink});
  return {capture,stream:verifiedStream(body,expected,trace,{digestFactory,...options})};
}
for(const [kind,body] of [['short',new Uint8Array(2)],['extra',new Uint8Array(100)],['huge chunk',new Uint8Array(1048577)]])
  test('bounded stream rejects '+kind+' and never logs success',async()=>{
    const {capture,stream}=observe(new Response(body).body);await assert.rejects(new Response(stream).arrayBuffer());assert(!capture.records.some(r=>r.event==='stream.verified'));assert.equal(capture.records.filter(r=>r.event==='request.complete'&&r.status===502).length,1);
  });
test('idle stream timeout cancels upstream and records failure',async()=>{
  let cancelled=false;const {capture,stream}=observe(new ReadableStream({cancel(){cancelled=true;}}),undefined,{idleMs:5,totalMs:20});
  await assert.rejects(new Response(stream).arrayBuffer(),/StreamIdleTimeout/);assert(cancelled);assert(capture.records.some(r=>r.event==='stream.failed'&&r.reason==='StreamIdleTimeout'));
});
test('client cancellation is a terminal 499 and aborts optional cache',async()=>{
  let aborted=false,cancelled=false;const writer=new WritableStream({abort(){aborted=true;}}).getWriter();
  const {capture,stream}=observe(new ReadableStream({cancel(){cancelled=true;}}),undefined,{cacheWriter:writer});await stream.cancel();assert(aborted&&cancelled);assert(capture.records.some(r=>r.event==='request.complete'&&r.status===499));
});
test('slow cache branch is bounded and serving completes without it',async()=>{
  const writer=new WritableStream({write(){return new Promise(()=>{});}}).getWriter();
  const {capture,stream}=observe(new Response(payload).body,undefined,{cacheWriter:writer,lagMs:5});
  assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()),payload);assert(capture.records.some(r=>r.event==='cache.branch_dropped'));assert(capture.records.some(r=>r.event==='stream.verified'));
});
test('bounded metadata body timeout cancels its actual reader',async()=>{
  let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  await assert.rejects(boundedBody(response,100,'DocumentLimit',{idleMs:5,totalMs:10}),/OriginBodyTimeout/);assert(cancelled);
});
test('origin total deadline rejects without another outbound request',async()=>{
  let time=0,calls=0;const origin=new GitHubOrigin({trace:new Trace({sink:()=>{}}),now:()=>time,totalMs:10,fetcher:()=>{calls++;}});time=11;
  await assert.rejects(origin.call('https://api.github.com/repos/a/b','application/json'),/OriginTotalTimeout/);assert.equal(calls,0);
});
for(const location of ['http://release-assets.githubusercontent.com/github-production-release-asset/10/x','https://evil.test/SECRET','https://user:SECRET@release-assets.githubusercontent.com/github-production-release-asset/10/x','https://api.github.com/SECRET','https://release-assets.githubusercontent.com/SECRET'])
  test('untrusted binary redirect is denied without contacting target: '+new URL(location).hostname,async()=>{
    const data=await fixture(),capture=traceCapture(),mock=mockGithub(data,{mutate:async(url,options,response)=>url.pathname==='/repos/author/package/releases/assets/40'&&options.headers.get('Accept')==='application/octet-stream'?new Response(null,{status:302,headers:{Location:location}}):response});
    const worker=createGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory});const url=`https://repo.example.test/v1/sources/test.local/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`;
    const response=await worker.fetch(new Request(url),testEnv(),context());assert(response.status>=400);assert.equal((await response.json()).code,'OriginRedirectRejected');assert(!JSON.stringify(capture.records).includes('SECRET'));assert(!mock.calls.some(c=>c.url.href===location));
  });
test('event limit records truncation and preserves exactly one terminal event',()=>{
  const capture=traceCapture(),trace=new Trace({sink:capture.sink});for(let i=0;i<200;i++)trace.event('test.event');trace.finish(503,'OriginUnavailable');trace.finish(200);
  assert(capture.records.length<=81);assert.equal(capture.records.filter(r=>r.event==='audit.truncated').length,1);assert.equal(capture.records.filter(r=>r.event==='request.complete'&&r.status===503).length,1);
});
