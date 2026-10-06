// Explicit native workerd/SQLite/R2 check. Does not create cloud resources or use real GitHub.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import { fixture, mockGithub, testEnv, cacheConfig, sha, binary, encode } from './helpers.mjs';
const data=await fixture(),config=cacheConfig();
let corrupt=false;
const wrong=new Uint8Array(data.payload);wrong[0]^=1;
const mock=mockGithub(data,{mutate:async(url,options,response)=>corrupt&&url.pathname==='/repos/author/package/releases/assets/40'&&options.headers.get('Accept')==='application/octet-stream'?binary(wrong):response});
const state=await mkdtemp(join(tmpdir(),'phinix-native-'));
const bundleRoot=fileURLToPath(new URL('../.wrangler/dry-run/',import.meta.url));
const opsRoot=fileURLToPath(new URL('../.wrangler/ops-dry-run/',import.meta.url));
const stagingRoot=fileURLToPath(new URL('../.wrangler/production-dry-run/',import.meta.url));
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
class CaptureLog extends Log {
  constructor(){super(LogLevel.INFO);this.lines=[];}
  log(message){this.lines.push(message);}
}
const log=new CaptureLog();
const runtime=new Miniflare(convertV4MiniflareOptions({ log, cf:false, resourcePersistencePath:state, isolatedResourcePersistencePath:state, workers: [{ name:'gateway',
  modules:true,modulesRoot:bundleRoot,scriptPath:join(bundleRoot,'index.js'),
  compatibilityDate:'2026-10-03',
  bindings:testEnv({R2_ENABLED:'true',CACHE_CONFIG:JSON.stringify(config),ORIGIN_METADATA_CACHE_SECONDS:'30',CACHE_OPERATIONS_ENABLED:'true'}),
  durableObjects:{CACHE_COORDINATOR:{className:'CacheCoordinator',useSQLite:true}},r2Buckets:['PACKAGES'],
  outboundService:async request=>{const response=await mock.fetcher(request.url,{headers:request.headers});return new RuntimeResponse(await response.arrayBuffer(),{status:response.status,headers:Object.fromEntries(response.headers)});}
}, { name:'operator',modules:true,modulesRoot:opsRoot,scriptPath:join(opsRoot,'local-bridge.js'),compatibilityDate:'2026-10-03',serviceBindings:{REPOSITORY_OPERATIONS:{name:'gateway',entrypoint:'RepositoryOperations'}} },
{ name:'recovery',modules:[{type:'ESModule',path:join(projectRoot,'tests/native-recovery-worker.mjs')},{type:'ESModule',path:join(bundleRoot,'index.js')}],modulesRoot:projectRoot,compatibilityDate:'2026-10-03',bindings:testEnv({CACHE_CONFIG:JSON.stringify(config),CACHE_OPERATIONS_ENABLED:'true'}),durableObjects:{CACHE_COORDINATOR:{className:'RecoveryFaultCoordinator',useSQLite:true}},r2Buckets:{PACKAGES:'native-recovery-isolated'} },
{ name:'staging',modules:true,modulesRoot:stagingRoot,scriptPath:join(stagingRoot,'read-only.js'),compatibilityDate:'2026-10-03',
  bindings:testEnv({REPOSITORY_ENABLED:'true',POC_MODE:'false',GITHUB_TOKEN:'SECRET_NATIVE_STAGING'}),
  ratelimits:{REQUEST_LIMITER:{namespace_id:'233310041',simple:{limit:30,period:60}}},
  outboundService:async request=>{const response=await mock.fetcher(request.url,{headers:request.headers});return new RuntimeResponse(await response.arrayBuffer(),{status:response.status,headers:Object.fromEntries(response.headers)});}
}
] }));
try {
  const root='https://repo.example.test/v1/sources/test.local';
  const staging=await runtime.getWorker('staging');
  const anonymous=await staging.fetch(root+'/stable');assert.equal(anonymous.status,200);assert.equal(anonymous.headers.get('Cache-Control'),'no-store');assert.deepEqual(new Uint8Array(await anonymous.arrayBuffer()),data.stable);
  const stagingUrl=`${root}/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`;
  const stagingZip=await staging.fetch(stagingUrl);assert.equal(stagingZip.status,200);assert.equal(stagingZip.headers.get('Content-Length'),String(data.payload.length));assert.deepEqual(new Uint8Array(await stagingZip.arrayBuffer()),data.payload);
  assert.equal((await staging.fetch(root+'/stable',{method:'POST'})).status,405);
  const metadata=await runtime.dispatchFetch(root+'/stable');assert.equal(metadata.status,200);assert.deepEqual(new Uint8Array(await metadata.arrayBuffer()),data.stable);
  const url=`${root}/snapshots/${data.snapshot}/packages/a/1.0.0/${sha(data.payload)}/package`;
  const first=await runtime.dispatchFetch(url);assert.equal(first.status,200);assert.deepEqual(new Uint8Array(await first.arrayBuffer()),data.payload);
  const bucket=await runtime.getR2Bucket('PACKAGES');
  const key=`test.local/packages/a/1.0.0/${sha(data.payload)}/package`;
  let stored;
  for(let count=0;count<30;count++){stored=await bucket.get(key);if(stored)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert(stored,'Native R2 fill did not commit');assert.equal(stored.size,data.payload.length);assert.equal(Buffer.from(stored.checksums.sha256).toString("hex"),sha(data.payload));
  mock.calls.length=0;const second=await runtime.dispatchFetch(url);assert.deepEqual(new Uint8Array(await second.arrayBuffer()),data.payload);
  assert(!mock.calls.some(c=>c.url.pathname.startsWith('/repos/author/')),'Native hit should not fetch author origin');
  assert.equal(mock.calls.length,0,'Native warm metadata + R2 should make no GitHub calls');
  const operator=await runtime.getWorker('operator');
  const inspection=await operator.fetch('http://127.0.0.1:18787/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'inspect',input:{schemaVersion:1,epoch:config.epoch,period:config.period}})});
  const inspected=await inspection.json();assert.equal(inspection.status,200);assert(inspected.ok);assert.equal(inspected.result.objects.length,1);assert.equal(inspected.result.meta.classA,3);
  const recovery=await runtime.getWorker('recovery');
  const call=async(path,input)=>{const response=await recovery.fetch('https://native-recovery.test/'+path,{method:'POST',body:JSON.stringify(input)});return response.json();};
  const proof=encode('native recovery proof'),entry={source:'test.local',package:'recovery',version:'1.0.0',sha256:sha(proof),sizeBytes:proof.length},target={schemaVersion:1,epoch:config.epoch,period:config.period};
  assert.equal((await call('lose-ack',entry)).status,503);
  const before=await call('inspect',target);assert(before.ok);assert.equal(before.result.objects[0].entry.state,'uncertain');
  const selected=before.result.objects[0],confirmed=await call('confirm',{...target,entry,lease:selected.entry.lease,fingerprint:selected.fingerprint});assert(confirmed.ok);assert.equal(confirmed.result.capacityReleased,false);assert.deepEqual(confirmed.result.totals,before.result.totals);
  const recovered=await recovery.fetch('https://native-recovery.test/get',{method:'POST',body:JSON.stringify(entry)});assert.equal(recovered.status,200);assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()),proof);
  await bucket.delete(key);corrupt=true;
  let rejected=false;
  try {const bad=await runtime.dispatchFetch(url),received=new Uint8Array(await bad.arrayBuffer());rejected=bad.status>=500||received.byteLength<data.payload.length;}
  catch {rejected=true;}
  assert(rejected,'Native DigestStream must withhold the complete corrupt payload');
  assert.equal(await bucket.get(key),null,'Rejected stream must not refill a missing tracked object');
  console.log('Native workerd: anonymous staging + limiter binding, SQLite DO/R2 stream/cache, internal RPC, inspection and lost-ack recovery without freeing capacity passed.');
} finally {await runtime.dispose();await rm(state,{recursive:true,force:true});}
