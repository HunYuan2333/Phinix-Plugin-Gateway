import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway.mjs';
import { Trace } from '../src/audit.mjs';
import { strictJson } from '../src/protocol.mjs';
import { fixture,mockGithub,testEnv,context,traceCapture,digestFactory,commit,publicationCommit,encode,sha,json,coordinator } from './helpers.mjs';
const root='https://repo.example.test/v1/sources/test.local';
const pathFor=data=>`${root}/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`;
const gateway=(mock,capture)=>createGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory,cachePipeFactory:()=>new TransformStream()});
test('response framing preserves locked size and verification before delivering bytes',async()=>{
  const data=await fixture(),mock=mockGithub(data),capture=traceCapture(),tasks=context();let framed;
  const worker=createGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory,responsePipeFactory:size=>{framed=size;return new TransformStream();}});
  const response=await worker.fetch(new Request(pathFor(data)),testEnv(),tasks);
  assert.equal(response.status,200);assert.equal(framed,data.payload.length);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),data.payload);await tasks.flush();
  assert.equal(capture.records.filter(r=>r.event==='stream.verified').length,1);
  assert.equal(capture.records.filter(r=>r.event==='request.complete'&&r.status===200).length,1);
});
test('response framing cannot deliver a complete corrupt package or hide stream failure',async()=>{
  const data=await fixture(),wrong=new Uint8Array(data.payload);wrong[0]^=1;
  const mock=mockGithub(data,{packageBytes:wrong}),capture=traceCapture(),tasks=context();
  const worker=createGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory,responsePipeFactory:()=>new TransformStream()});
  const response=await worker.fetch(new Request(pathFor(data)),testEnv(),tasks);
  await assert.rejects(response.arrayBuffer());await tasks.flush();
  assert(!capture.records.some(r=>r.event==='stream.verified'));
  assert.equal(capture.records.filter(r=>r.event==='request.complete'&&r.status>=500).length,1);
});
test('response framing propagates client cancellation to origin with one terminal audit',async()=>{
  const data=await fixture(),capture=traceCapture(),tasks=context();let cancelled=0;
  const mock=mockGithub(data,{mutate:(url,options,response)=>{
    if(url.pathname==='/repos/author/package/releases/assets/40'&&options.headers.get('Accept')==='application/octet-stream')
      return new Response(new ReadableStream({start(controller){controller.enqueue(data.payload.slice(0,1));},cancel(){cancelled++;}}),
        {headers:{'Content-Type':'application/octet-stream','Content-Length':String(data.payload.length)}});
    return response;
  }});
  const worker=createGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory,responsePipeFactory:()=>new TransformStream()});
  const response=await worker.fetch(new Request(pathFor(data)),testEnv(),tasks),reader=response.body.getReader();
  assert.equal((await reader.read()).value.length,1);await reader.cancel();await tasks.flush();
  assert.equal(cancelled,1);assert(capture.records.some(r=>r.event==='stream.cancelled'));
  assert(!capture.records.some(r=>r.event==='stream.verified'));
  assert.equal(capture.records.filter(r=>r.event==='request.complete'&&r.status===499).length,1);
});
test('origin rate limit retains bounded numeric diagnostics without error bodies',async()=>{
  const capture=traceCapture(),worker=createGateway({sink:capture.sink,fetcher:async()=>new Response('SECRET_ERROR_BODY',{status:403,headers:{'X-RateLimit-Remaining':'0','X-RateLimit-Reset':'1791046800','Retry-After':'3600'}})});
  const response=await worker.fetch(new Request(root+'/stable'),testEnv(),context());assert.equal(response.status,503);assert.equal((await response.json()).code,'OriginRateLimited');
  const event=capture.records.find(r=>r.event==='origin.response');assert.equal(event.rateLimitRemaining,0);assert.equal(event.rateLimitReset,1791046800);assert.equal(event.retryAfterSeconds,3600);assert(!JSON.stringify(capture.records).includes('SECRET'));
});
test('origin rate diagnostics discard arbitrary or oversized header strings',async()=>{
  const capture=traceCapture(),worker=createGateway({sink:capture.sink,fetcher:async()=>new Response(null,{status:429,headers:{'X-RateLimit-Remaining':'SECRET','X-RateLimit-Reset':'999999999999999999','Retry-After':'86401'}})});
  assert.equal((await worker.fetch(new Request(root+'/stable'),testEnv(),context())).status,503);
  const event=capture.records.find(r=>r.event==='origin.response');assert(!('rateLimitRemaining' in event));assert(!('rateLimitReset' in event));assert(!('retryAfterSeconds' in event));assert(!JSON.stringify(capture.records).includes('SECRET'));
});
for(const input of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"a":1,}','{}{}','{"a":/*x*/1}','{"a":NaN}','{"a":"\n"}'])
  test('strict JSON rejects '+JSON.stringify(input),()=>assert.throws(()=>strictJson(encode(input))));
test('UTF-8, depth, size and prototype protection',()=>{
  assert.throws(()=>strictJson(new Uint8Array([255])));assert.throws(()=>strictJson(new Uint8Array(16385)));assert.throws(()=>strictJson(encode('['.repeat(34)+'0'+']'.repeat(34))));
  assert.equal(strictJson(encode('{"__proto__":{"admin":true}}')).__proto__.admin,true);assert.equal({}.admin,undefined);
});
for(const suffix of ['/stable?url=SECRET','/stable/','//stable','/%73table','/snapshots/main/catalog/'+'a'.repeat(64),'/snapshots/'+commit+'/packages/a/v1.0.0/'+'a'.repeat(64)+'/package'])
  test('bad path never reaches origin: '+suffix.split('?')[0],async()=>{
    const capture=traceCapture();let calls=0;const worker=createGateway({sink:capture.sink,fetcher:()=>{calls++;throw new Error('Unexpected');}});
    const response=await worker.fetch(new Request(root+suffix),testEnv(),context());assert(response.status>=400);assert.equal(calls,0);assert(!JSON.stringify(capture.records).includes('SECRET'));
  });
test('methods, Range and unknown source are denied without origin',async()=>{
  let calls=0;const worker=createGateway({sink:()=>{},fetcher:()=>{calls++;}});
  assert.equal((await worker.fetch(new Request(root+'/stable',{method:'POST'}),testEnv(),context())).status,405);
  assert.equal((await worker.fetch(new Request(root+'/stable',{headers:{Range:'bytes=0-1'}}),testEnv(),context())).status,416);
  assert.equal((await worker.fetch(new Request(root.replace('test.local','evil.source')+'/stable'),testEnv(),context())).status,404);assert.equal(calls,0);
});
test('stable pins one publication commit, including conditional revalidation',async()=>{
  const data=await fixture(),mock=mockGithub(data),capture=traceCapture(),worker=gateway(mock,capture);
  const response=await worker.fetch(new Request(root+'/stable'),testEnv(),context());assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),data.stable);
  assert(mock.calls.filter(c=>c.url.pathname.includes('/contents/')).every(c=>c.url.searchParams.get('ref')===publicationCommit));
  const second=await worker.fetch(new Request(root+'/stable',{headers:{'If-None-Match':response.headers.get('ETag')}}),testEnv(),context());assert.equal(second.status,304);assert.equal(capture.records.filter(r=>r.event==='request.complete').length,2);
});
test('published and catalog bind fixed raw bytes',async()=>{
  const data=await fixture(),mock=mockGithub(data),capture=traceCapture(),worker=gateway(mock,capture);
  for(const [kind,bytes] of [['published',data.published],['catalog',data.catalog]]){
    const response=await worker.fetch(new Request(`${root}/snapshots/${data.snapshot}/${kind}/${sha(bytes)}`),testEnv(),context());assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  }
});
for(const fault of ['private','owner','draft','membership','tag','commit','hash','length'])
  test('origin rejects '+fault+' with correlated failure code',async()=>{
    const data=await fixture(),capture=traceCapture();const mock=mockGithub(data,{mutate:async(url,options,response)=>{
      if(fault==='hash'&&url.pathname.endsWith('/contents/published/'+data.snapshot+'.json'))return new Response(encode(new TextDecoder().decode(data.published).replace('catalog.json','changed.json')));
      if(fault==='length'&&url.pathname==='/repos/test-owner/index/releases/assets/4'&&options.headers.get('Accept')==='application/octet-stream')response.headers.set('Content-Length','1');
      if(options.headers.get('Accept')!=='application/vnd.github+json')return;
      const value=await response.clone().json();
      if(fault==='private'&&url.pathname==='/repos/author/package')value.private=true;
      if(fault==='owner'&&url.pathname==='/repos/author/package')value.owner.id=99;
      if(fault==='draft'&&url.pathname==='/repos/author/package/releases/30')value.draft=true;
      if(fault==='membership'&&url.pathname==='/repos/author/package/releases/30')value.assets=[];
      if(fault==='tag'&&url.pathname==='/repos/author/package/releases/30')value.tag_name='v2.0.0';
      if(fault==='commit'&&url.pathname.includes('/git/ref/tags/'))value.object.sha='9'.repeat(40);
      return json(value);
    }});
    const response=await gateway(mock,capture).fetch(new Request(fault==='hash'?root+'/stable':pathFor(data)),testEnv(),context());assert(response.status>=400);const error=await response.json();assert.equal(error.requestId,response.headers.get('X-Phinix-Request-Id'));assert(capture.records.some(r=>r.requestId===error.requestId&&r.event==='request.rejected'&&r.reason===error.code));
  });
test('redirects preserve serving boundary and redact credentials',async()=>{
  const data=await fixture(),capture=traceCapture(),mock=mockGithub(data,{redirect:true});
  const response=await gateway(mock,capture).fetch(new Request(pathFor(data),{headers:{'X-Phinix-Client-Request-Id':'b'.repeat(32)}}),testEnv({GITHUB_TOKEN:'SECRET_GITHUB_TOKEN'}),context());assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),data.payload);
  assert(!mock.calls.find(c=>c.url.hostname==='release-assets.githubusercontent.com').options.headers.has('Authorization'));assert(!response.headers.has('Location'));assert(!JSON.stringify(capture.records).includes('SECRET'));assert(capture.records.some(r=>r.event==='stream.verified'&&r.clientRequestId==='b'.repeat(32)));
});
test('withdrawal and forged hash never fetch author bytes',async()=>{
  const data=await fixture({packageState:'withdrawn'}),capture=traceCapture(),mock=mockGithub(data);
  assert.equal((await gateway(mock,capture).fetch(new Request(pathFor(data)),testEnv(),context())).status,410);assert(!mock.calls.some(c=>c.url.pathname.startsWith('/repos/author/')));
  const active=await fixture(),other=mockGithub(active);assert.equal((await gateway(other,capture).fetch(new Request(pathFor(active).replace(sha(active.payload),'f'.repeat(64))),testEnv(),context())).status,404);assert(!other.calls.some(c=>c.url.pathname.startsWith('/repos/author/')));
});
test('200 headers do not hide corrupted stream terminal failure',async()=>{
  const data=await fixture(),capture=traceCapture(),wrong=new Uint8Array(data.payload);wrong[0]^=1;
  const response=await gateway(mockGithub(data,{packageBytes:wrong}),capture).fetch(new Request(pathFor(data)),testEnv(),context());assert.equal(response.status,200);await assert.rejects(response.arrayBuffer(),/StreamDigestMismatch/);
  assert(capture.records.some(r=>r.event==='stream.headers_sent'));assert(!capture.records.some(r=>r.event==='stream.verified'));assert(capture.records.some(r=>r.event==='request.complete'&&r.reason==='StreamDigestMismatch'&&r.status===502));
});
test('R2 miss -> verified fill -> hit without author origin',async()=>{
  const data=await fixture(),capture=traceCapture(),cache=coordinator({sink:capture.sink}),mock=mockGithub(data),worker=gateway(mock,capture),env=testEnv({R2_ENABLED:'true',CACHE_COORDINATOR:cache.binding}),ctx=context();
  const first=await worker.fetch(new Request(pathFor(data)),env,ctx);assert.deepEqual(new Uint8Array(await first.arrayBuffer()),data.payload);await ctx.flush();assert(capture.records.some(r=>r.event==='cache.fill_committed'));
  mock.calls.length=0;const second=await worker.fetch(new Request(pathFor(data)),env,context());assert.deepEqual(new Uint8Array(await second.arrayBuffer()),data.payload);assert(!mock.calls.some(c=>c.url.pathname.startsWith('/repos/author/')));assert(capture.records.some(r=>r.event==='cache.r2_hit'));
});
test('coordinator failure continues through Worker origin without client redirect',async()=>{
  const data=await fixture(),capture=traceCapture(),mock=mockGithub(data),binding={idFromName:()=>'',get:()=>({fetch:async request=>{request.body?.cancel().catch(()=>{});throw new Error('Unavailable SECRET_TOKEN');}})},ctx=context();
  const response=await gateway(mock,capture).fetch(new Request(pathFor(data)),testEnv({R2_ENABLED:'true',CACHE_COORDINATOR:binding}),ctx);assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),data.payload);await ctx.flush();assert(!response.headers.has('Location'));assert(!JSON.stringify(capture.records).includes('SECRET'));
});
test('audit allowlist, bounded fields, one terminal and sink failure',()=>{
  const capture=traceCapture(),trace=new Trace({sink:capture.sink});trace.event('test.event',{reason:'safe',token:'SECRET',url:'https://evil/?sig=SECRET',originHost:'evil\nsecret',bytes:12,status:NaN});trace.finish(200);trace.finish(500);assert.equal(capture.records.length,2);assert(!JSON.stringify(capture.records).includes('SECRET'));assert.doesNotThrow(()=>new Trace({sink:()=>{throw new Error('down');}}).event('test.event'));
});

test('controlled PoC gate fails closed before origin and never logs the token',async()=>{
  const data=await fixture(),mock=mockGithub(data),capture=traceCapture(),worker=gateway(mock,capture);const secret='a'.repeat(64),env=testEnv({POC_MODE:'true',POC_ACCESS_TOKEN:secret,POC_EXPIRES_AT:String(Date.now()+86400000)});
  for (const headers of [{},{Authorization:'Bearer '+'b'.repeat(64)},{Authorization:'Bearer invalid'}]) {
    assert.equal((await worker.fetch(new Request(root+'/stable',{headers}),env,context())).status,401);
  }
  assert.equal(mock.calls.length,0);const result=await worker.fetch(new Request(root+'/stable',{headers:{Authorization:'Bearer '+secret}}),env,context());assert.equal(result.status,200);assert.equal(result.headers.get('Cache-Control'),'no-store');
  assert(!JSON.stringify(capture.records).includes(secret));
});
test('controlled PoC configuration with missing token is closed',async()=>{
  let calls=0;const worker=createGateway({sink:()=>{},fetcher:()=>{calls++;}});
  assert.equal((await worker.fetch(new Request(root+'/stable'),testEnv({POC_MODE:'true'}),context())).status,503);assert.equal(calls,0);
});

test('expired controlled PoC stops before origin',async()=>{
  let calls=0;const worker=createGateway({sink:()=>{},fetcher:()=>{calls++;}});
  assert.equal((await worker.fetch(new Request(root+'/stable',{headers:{Authorization:'Bearer '+'a'.repeat(64)}}),testEnv({POC_MODE:'true',POC_ACCESS_TOKEN:'a'.repeat(64),POC_EXPIRES_AT:'1000000000000'}),context())).status,410);assert.equal(calls,0);
});
