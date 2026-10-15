import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {catalog,selectedPackage,validateThemeManifest} from '../src/protocol.mjs';
import {fixture,encode,sha,source,mockGithub,testEnv,context,traceCapture,digestFactory} from './helpers.mjs';
import {createReadOnlyGateway} from '../src/read-only.mjs';
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
test('theme CF streaming uses immutable source and asset proofs',async()=>{
 const data=await fixture();const old=JSON.parse(new TextDecoder().decode(data.catalog)).packages[0];
 const m={...structuredClone(sample.manifest),packageId:old.id,version:old.version};
 const record={...structuredClone(sample),id:old.id,manifest:m,artifact:{...data.artifact,payloadKind:'theme-zip'}};
 data.artifact=record.artifact;data.catalog=encode({schemaVersion:4,sourceId:source.sourceId,snapshotId:data.snapshot,packages:[record]});
 data.publishedObject={...data.publishedObject,catalogSchemaVersion:4,catalogSha256:sha(data.catalog),catalogSizeBytes:data.catalog.length};data.published=encode(data.publishedObject);
 const {repository,repositoryId,ownerId,releaseId,assetId,assetName,...shared}=data.publishedObject;
 data.stable=encode({...shared,publishedSha256:sha(data.published),publishedSizeBytes:data.published.length});
 const mock=mockGithub(data),capture=traceCapture();const worker=createReadOnlyGateway({fetcher:mock.fetcher,sink:capture.sink,digestFactory});
 const env=testEnv({REPOSITORY_ENABLED:'true',POC_MODE:'false',GITHUB_TOKEN:'SECRET_ORIGIN_TOKEN',REQUEST_LIMITER:{limit:async()=>({success:true})}});
 const uri=`https://test.example/v1/sources/${source.sourceId}/snapshots/${data.snapshot}/packages/${record.id}/${m.version}/${record.artifact.sha256}/package`;
 const response=await worker.fetch(new Request(uri),env,context());
 assert.equal(response.status,200);assert.equal(sha(new Uint8Array(await response.arrayBuffer())),record.artifact.sha256);
});
