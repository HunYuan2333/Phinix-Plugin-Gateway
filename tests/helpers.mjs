import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CacheCoordinatorCore } from '../src/cache-coordinator.mjs';
export const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const source = { sourceId:'test.local',repository:'test-owner/index',repositoryId:'1',ownerId:'2',publicationBranch:'main' };
export const commit='1'.repeat(40), publicationCommit='2'.repeat(40), artifactCommit='3'.repeat(40);
export function traceCapture() { const records=[]; return { records,sink: line => records.push(JSON.parse(line)) }; }
export function digestFactory() {
  const hash=createHash('sha256'); let resolve,reject;
  const digest=new Promise((a,b)=>{resolve=a;reject=b;});digest.catch(()=>{});
  const stream=new WritableStream({write(chunk){hash.update(chunk);},close(){const b=hash.digest();resolve(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));},abort(error){reject(error);}});
  stream.digest=digest;return stream;
}
export async function fixture({snapshot=commit,packageState='active',payload=encode('trusted test ZIP bytes'),empty=false}={}) {
  const template=JSON.parse(await readFile(new URL('./fixtures/chain.catalog.json',import.meta.url),'utf-8')).packages[0];
  const artifact={...template.artifact,repository:'author/package',repositoryId:'10',ownerId:'20',sourceCommit:artifactCommit,tag:'v1.0.0',releaseId:'30',assetId:'40',assetName:'a.zip',sizeBytes:payload.length,sha256:sha(payload)};
  const catalog=encode({schemaVersion:1,sourceId:source.sourceId,snapshotId:snapshot,packages:empty?[]:[{...template,state:packageState,artifact}]});
  const common={schemaVersion:1,sourceId:source.sourceId,snapshotId:snapshot,catalogSchemaVersion:1,catalogSha256:sha(catalog),catalogSizeBytes:catalog.length};
  const publishedObject={...common,repository:source.repository,repositoryId:source.repositoryId,ownerId:source.ownerId,releaseId:'3',assetId:'4',assetName:'catalog.json'};
  const published=encode(publishedObject),stable=encode({...common,publishedSha256:sha(published),publishedSizeBytes:published.length});
  return {payload,artifact,catalog,published,publishedObject,stable,snapshot};
}
export function json(value,status=200){return new Response(encode(value),{status,headers:{'Content-Type':'application/json'}});}
export function binary(bytes){return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)}});}
export function mockGithub(data,{mutate,redirect=false,packageBytes=data.payload}={}) {
  const calls=[];
  const fetcher=async(input,options)=>{
    const url=new URL(input);calls.push({url,options});let response;
    if(url.hostname==='release-assets.githubusercontent.com')response=binary(packageBytes);
    else {
      const p=url.pathname;
      if(p==='/repos/test-owner/index')response=json({id:1,owner:{id:2},full_name:source.repository,private:false,visibility:'public'});
      else if(p==='/repos/author/package')response=json({id:10,owner:{id:20},full_name:'author/package',private:false,visibility:'public'});
      else if(p.endsWith('/git/ref/heads/main'))response=json({object:{type:'commit',sha:publicationCommit}});
      else if(p.endsWith('/contents/stable.json'))response=binary(data.stable);
      else if(p.endsWith('/contents/published/'+data.snapshot+'.json'))response=binary(data.published);
      else if(p==='/repos/test-owner/index/releases/3')response=json({id:3,draft:false,prerelease:false,assets:[{id:4,name:'catalog.json',size:data.catalog.length}]});
      else if(p==='/repos/test-owner/index/releases/assets/4')response=options.headers.get('Accept')==='application/octet-stream'?binary(data.catalog):json({id:4,name:'catalog.json',size:data.catalog.length,state:'uploaded',digest:'sha256:'+sha(data.catalog)});
      else if(p==='/repos/author/package/releases/30')response=json({id:30,tag_name:'v1.0.0',draft:false,prerelease:false,assets:[{id:40,name:'a.zip',size:data.payload.length}]});
      else if(p==='/repos/author/package/git/ref/tags/v1.0.0')response=json({object:{type:'commit',sha:artifactCommit}});
      else if(p==='/repos/author/package/releases/assets/40') {
        if(options.headers.get('Accept')!=='application/octet-stream')response=json({id:40,name:'a.zip',size:data.payload.length,state:'uploaded',digest:'sha256:'+sha(data.payload)});
        else response=redirect?new Response(null,{status:302,headers:{Location:'https://release-assets.githubusercontent.com/github-production-release-asset/10/data?sig=SECRET_SIGNED_URL'}}):binary(packageBytes);
      } else throw new Error('Unexpected simulated GitHub path: '+p);
    }
    response.headers.set('X-GitHub-Request-Id','TEST:GITHUB:TRACE');
    return mutate?(await mutate(url,options,response))??response:response;
  };return {fetcher,calls};
}
export function testEnv(extra={}){return {SOURCES:JSON.stringify([source]),BUILD_ID:'test-build',R2_ENABLED:'false',...extra};}
export function context(){const tasks=[];return {tasks,waitUntil(task){tasks.push(task);},async flush(){await Promise.all(tasks);}};}
export function cacheConfig(now=Date.now()){return {epoch:'test-cache-v1',period:'test-period',start:now-60000,end:now+3600000,capacity:20000,classA:100,classB:100,emptyConfirmed:true,maxFillBytes:8388608};}
export function sqliteStorage({database=new DatabaseSync(':memory:')}={}) {
  const storage={database,failEvent:null,failWrites:false,sql:{exec(query,...bindings){
    if(!query.startsWith('SELECT')&&(storage.failWrites||(query.startsWith('INSERT INTO audit')&&bindings[1]===storage.failEvent)))throw new Error('Injected SQL write failure');
    const statement=database.prepare(query),rows=query.startsWith('SELECT')?statement.all(...bindings):(statement.run(...bindings),[]);
    return {toArray:()=>rows,one:()=>{if(rows.length!==1)throw new Error('Expected one row');return rows[0];}};
  }},transactionSync(action){database.exec('BEGIN IMMEDIATE');try{const result=action();database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}}};return storage;
}
export class Bucket {
  constructor(){this.objects=new Map();this.calls=[];this.putAfterCommitReject=false;this.deleteReject=false;this.beforePut=null;}
  async list(){this.calls.push('list');return {objects:[...this.objects.keys()].slice(0,1).map(key=>({key})),truncated:this.objects.size>1};}
  async put(key,body,options={}) {
    this.calls.push('put:'+key);if(this.beforePut&&!key.startsWith('__phinix'))await this.beforePut(key);
    const bytes=new Uint8Array(await new Response(body).arrayBuffer());if(options.sha256&&sha(bytes)!==options.sha256)throw new Error('Checksum mismatch');
    const hash=createHash('sha256').update(bytes).digest(),object={bytes,size:bytes.length,checksums:{sha256:hash.buffer.slice(hash.byteOffset,hash.byteOffset+hash.byteLength)},customMetadata:options.customMetadata};
    this.objects.set(key,object);if(this.putAfterCommitReject&&!key.startsWith('__phinix'))throw new Error('Put acknowledgment lost SECRET_SIGNED_URL');return {...object};
  }
  async get(key){this.calls.push('get:'+key);const value=this.objects.get(key);return value?{...value,body:new Response(value.bytes).body}:null;}
  async delete(key){this.calls.push('delete:'+key);this.objects.delete(key);if(this.deleteReject)throw new Error('Delete acknowledgment lost');}
}
export function cacheRequest(kind,entry,body=null){return new Request('https://cache.internal/'+kind,{method:'POST',body:kind==='get'?JSON.stringify(entry):body,duplex:'half',headers:{'X-Phinix-Request-Id':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',...(kind==='put'?{'X-Phinix-Cache-Entry':JSON.stringify(entry)}:{})}});}
export function coordinator({storage=sqliteStorage(),bucket=new Bucket(),config=cacheConfig(),sink,now}={}) {
  const core=new CacheCoordinatorCore(storage,{CACHE_CONFIG:config,PACKAGES:bucket,BUILD_ID:'test'},{sink,now});
  return {core,storage,bucket,binding:{idFromName:name=>name,get:()=>({fetch:request=>core.fetch(request)})}};
}
