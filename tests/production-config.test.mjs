import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async name => JSON.parse(await readFile(new URL('../'+name,import.meta.url),'utf8'));
test('formal and transitional deployment commands retain the same official routes and service',async()=>{
  const production=await read('wrangler.production.jsonc'),alias=await read('wrangler.staging.jsonc');
  assert.deepEqual(alias,production);
  assert.equal(production.name,'phinix-plugin-repository-staging');
  assert.deepEqual(production.routes.map(r=>r.pattern),['plugins.hunyuan2333.com','plugins-staging.hunyuan2333.com']);
  assert(production.routes.every(r=>r.custom_domain===true && r.zone_name==='hunyuan2333.com'));
  assert.equal(production.workers_dev,false);assert.equal(production.preview_urls,false);
});
test('production cannot accidentally enable PoC storage, admin exports or arbitrary sources',async()=>{
  const production=await read('wrangler.production.jsonc');
  assert.equal(production.main,'src/cached.mjs');assert.equal(production.vars.REPOSITORY_ENABLED,'true');
  assert.equal(production.vars.PACKAGE_TOKEN_OWNER_ID,undefined);
  assert.equal(production.vars.POC_MODE,'false');assert.equal(production.vars.R2_ENABLED,'true');assert.equal(production.vars.EDGE_CACHE_ENABLED,'true');
  assert.equal(production.vars.CACHE_BUDGET_WINDOW,'utc-month');
  const budget=JSON.parse(production.vars.CACHE_CONFIG);assert.equal(budget.capacity,268435456);assert.equal(budget.classA,10000);assert.equal(budget.classB,100000);
  assert.equal(production.r2_buckets[0].bucket_name,'phinix-plugin-cache-production-20261015');
  assert.deepEqual(production.durable_objects.bindings,[{name:'CACHE_COORDINATOR',class_name:'CacheCoordinator'}]);
  for(const key of ['services'])assert.equal(production[key],undefined);
  for(const key of ['GITHUB_TOKEN','GITHUB_PACKAGE_TOKEN','POC_ACCESS_TOKEN'])assert.equal(production.vars[key],undefined);
  assert.deepEqual(JSON.parse(production.vars.SOURCES),[{sourceId:'phinix.official',repository:'HunYuan2333/Phinix-Plugin-Index',repositoryId:'1402564805',ownerId:'64630568',publicationBranch:'main'}, {sourceId:'phinix.themes',repository:'HunYuan2333/Phinix-Plugin-Index',repositoryId:'1402564805',ownerId:'64630568',publicationBranch:'themes'}]);
  assert.equal(production.ratelimits[0].simple.limit,30);assert.equal(production.ratelimits[0].simple.period,60);
});
