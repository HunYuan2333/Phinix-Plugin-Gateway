import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {catalog,selectedPackage,validateThemeManifest} from '../src/protocol.mjs';
import {fixture,encode,sha,source,mockGithub,testEnv,context,traceCapture,digestFactory,coordinator} from './helpers.mjs';
import {createReadOnlyGateway} from '../src/read-only.mjs';
import {createGateway} from '../src/gateway.mjs';
const sample=JSON.parse(await readFile(new URL('./fixtures/theme-submission.json',import.meta.url),'utf8')).package;
test('theme data route is separate and uses manifest version',async()=>{
 const bytes=encode({schemaVersion:4,sourceId:'phinix.themes',snapshotId:'a'.repeat(40),packages:[sample]});
 const index=await catalog(bytes,{catalogSchemaVersion:4,sourceId:'phinix.themes',snapshotId:'a'.repeat(40),catalogSha256:sha(bytes),catalogSizeBytes:bytes.length});
 const path={package:sample.id,version:sample.manifest.version,hash:sample.artifact.sha256};
 assert.equal(selectedPackage(index,path).payloadKind,'theme-zip');
 assert.throws(()=>selectedPackage(index,{...path,version:'9.0.0'}),/PackageNotFound/);
 index.packages[0].state='withdrawn'; assert.throws(()=>selectedPackage(index,path),/PackageUnavailable/);
});
test('theme manifest forbids code, traversal and duplicate paths',()=>{
 for(const edit of [m=>m.assemblies=[],m=>m.management='phinix-dll',m=>m.themes[0].path='Themes/../x.xml',m=>m.themes[0].path='Themes/CON.xml',m=>m.themes.push({...m.themes[0],id:'other'}),m=>m.themes[0].length=1048577]) {
  const m=structuredClone(sample.manifest);edit(m);assert.throws(()=>validateThemeManifest(m,sample.id));
 }
});
async function themeFixture() {
 const data=await fixture();const old=JSON.parse(new TextDecoder().decode(data.catalog)).packages[0];
 const m={...structuredClone(sample.manifest),packageId:old.id,version:old.version};
 const record={...structuredClone(sample),id:old.id,manifest:m,artifact:{...data.artifact,repository:'unrelated-author/theme',repositoryId:'999',ownerId:'777',payloadKind:'theme-zip'}};
 data.artifact=record.artifact;data.catalog=encode({schemaVersion:4,sourceId:source.sourceId,snapshotId:data.snapshot,packages:[record]});
 data.publishedObject={...data.publishedObject,catalogSchemaVersion:4,catalogSha256:sha(data.catalog),catalogSizeBytes:data.catalog.length};data.published=encode(data.publishedObject);
 const {repository,repositoryId,ownerId,releaseId,assetId,assetName,...shared}=data.publishedObject;
 data.stable=encode({...shared,publishedSha256:sha(data.published),publishedSizeBytes:data.published.length});
 const mirror={id:50,name:'theme-'+sha(data.payload)+'.zip',size:data.payload.length,state:'uploaded',digest:'sha256:'+sha(data.payload)};
 return {data,record,m,mirror};
}
for(const fault of [null,'missing','duplicate','length','digest','corrupt','withdrawn']) test('third-party theme mirrored delivery '+fault,async()=>{
 const {data,record,m,mirror}=await themeFixture();const calls=[],capture=traceCapture();
 if(fault==='withdrawn') {
  const index=JSON.parse(new TextDecoder().decode(data.catalog));index.packages[0].state='withdrawn';data.catalog=encode(index);
  Object.assign(data.publishedObject,{catalogSha256:sha(data.catalog),catalogSizeBytes:data.catalog.length});data.published=encode(data.publishedObject);
 }
 const mock=mockGithub(data,{mutate:async(url,options,response)=>{
  if(url.pathname==='/repos/test-owner/index/releases/3') {
   const release=await response.json();
   if(fault!=='missing')release.assets.push({...mirror,...(fault==='length'?{size:1}:{}),...(fault==='digest'?{digest:'sha256:'+'f'.repeat(64)}:{})});
   if(fault==='duplicate')release.assets.push({...mirror,id:51});
   return new Response(encode(release),{headers:{'Content-Type':'application/json'}});
  }
 }});
 const fetcher=async(input,options)=>{
  const url=new URL(input);calls.push({url,options});
  assert.equal(url.hostname,'api.github.com');assert(url.pathname.startsWith('/repos/test-owner/index'));
  assert.equal(options.headers.get('Authorization'),'Bearer ROOT_SECRET');
  if(url.pathname==='/repos/test-owner/index/releases/assets/50') {
   if(options.headers.get('Accept')!=='application/octet-stream')return new Response(encode(mirror));
   const bytes=new Uint8Array(data.payload);if(fault==='corrupt')bytes[0]^=1;
   return new Response(bytes,{headers:{'Content-Type':'application/zip','Content-Length':String(bytes.length)}});
  }
  return mock.fetcher(input,options);
 };
 const worker=createReadOnlyGateway({fetcher,sink:capture.sink,digestFactory});
 const env=testEnv({REPOSITORY_ENABLED:'true',POC_MODE:'false',GITHUB_TOKEN:'ROOT_SECRET',REQUEST_LIMITER:{limit:async()=>({success:true})}});
 const uri=`https://test.example/v1/sources/${source.sourceId}/snapshots/${data.snapshot}/packages/${record.id}/${m.version}/${record.artifact.sha256}/package`;
 const response=await worker.fetch(new Request(uri),env,context());
 if(fault==='corrupt') { assert.equal(response.status,200);await assert.rejects(response.arrayBuffer(),/StreamDigestMismatch/); }
 else if(fault) { assert(response.status>=400);assert(!calls.some(c=>c.url.pathname.endsWith('/assets/50'))); }
 else { assert.equal(response.status,200);assert.equal(sha(new Uint8Array(await response.arrayBuffer())),record.artifact.sha256); }
 assert(!JSON.stringify(capture.records).includes('ROOT_SECRET'));
});

test('third-party theme uses existing verified R2 cache without author credentials',async()=>{
 const {data,record,m,mirror}=await themeFixture(),capture=traceCapture(),cache=coordinator({sink:capture.sink});let deliveries=0;
 const mock=mockGithub(data,{mutate:async(url,options,response)=>{
  if(url.pathname==='/repos/test-owner/index/releases/3') {
   const release=await response.json();release.assets.push(mirror);return new Response(encode(release));
  }
 }});
 const fetcher=async(input,options)=>{
  const url=new URL(input);assert(url.pathname.startsWith('/repos/test-owner/index'));
  if(url.pathname.endsWith('/assets/50')) {
   if(options.headers.get('Accept')!=='application/octet-stream')return new Response(encode(mirror));
   deliveries++;return new Response(data.payload,{headers:{'Content-Type':'application/zip','Content-Length':String(data.payload.length)}});
  }
  return mock.fetcher(input,options);
 };
 const worker=createGateway({fetcher,sink:capture.sink,digestFactory,cachePipeFactory:()=>new TransformStream()});
 const env=testEnv({R2_ENABLED:'true',CACHE_COORDINATOR:cache.binding,GITHUB_TOKEN:'ROOT_SECRET'});
 const url=`https://test.example/v1/sources/${source.sourceId}/snapshots/${data.snapshot}/packages/${record.id}/${m.version}/${record.artifact.sha256}/package`;
 for(let i=0;i<2;i++) { const ctx=context(),response=await worker.fetch(new Request(url),env,ctx);
  assert.equal(response.status,200);assert.equal(sha(new Uint8Array(await response.arrayBuffer())),record.artifact.sha256);await ctx.flush(); }
 assert.equal(deliveries,1);assert(capture.records.some(r=>r.event==='cache.fill_committed'));assert(capture.records.some(r=>r.event==='cache.r2_hit'));
});
