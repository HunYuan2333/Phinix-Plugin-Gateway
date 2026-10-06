import { Trace, GatewayError, errorResponse, safeError } from './audit.mjs';
import { route, sources, stable, published, verifyBytes, catalog, selectedPackage, digest, requireThat, MAX_CATALOG } from './protocol.mjs';
import { GitHubOrigin, boundedBody } from './github.mjs';
import { verifiedStream, startFill } from './stream.mjs';
import { OriginMetadataCache } from './origin-metadata-cache.mjs';

export function createGateway({ fetcher = (...args) => fetch(...args), sink, digestFactory, cachePipeFactory, now = Date.now, beforeOrigin, metadataNoStore = false,
  responsePipeFactory = typeof FixedLengthStream === 'function' ? size => new FixedLengthStream(size) : null } = {}) {
  const metadataCache = new OriginMetadataCache({ now });
  return { async fetch(request, env, context) {
    const trace = new Trace({ sink, now, build: env.BUILD_ID, clientId: request.headers.get('X-Phinix-Client-Request-Id') });
    trace.event('request.accepted');
    try {
      await authorizePoc(request, env);
      const path = route(request); const source = sources(env).get(path.source);
      requireThat(source, 'SourceNotAllowed', 404);
      Object.assign(trace.base, { source: path.source, ...(path.snapshot ? { snapshot: path.snapshot } : {}), ...(path.package ? { package: path.package, version: path.version, sha256: path.hash } : {}) });
      if (beforeOrigin) await beforeOrigin(request, env, trace);
      const seconds = env.ORIGIN_METADATA_CACHE_SECONDS ?? '0';
      requireThat(/^(0|[1-9][0-9]{0,2})$/.test(seconds) && Number(seconds) <= 300, 'InvalidOriginCacheConfiguration', 503);
      const fresh = /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(request.headers.get('Cache-Control') ?? '');
      const origin = new GitHubOrigin({ fetcher, trace, token: env.GITHUB_TOKEN, metadataCache, metadataTtlMs: Number(seconds) * 1000, fresh, now });
      // Pin publication branch once per request. Stable/descriptor cannot come from two racing heads.
      const commit = await origin.publication(source);
      if (path.kind === 'stable') {
        const raw = await origin.file(source, commit, 'stable.json'); const pointer = stable(raw, path.source);
        const descriptor = await origin.file(source, commit, 'published/' + pointer.snapshotId + '.json');
        await verifyBytes(descriptor, pointer.publishedSizeBytes, pointer.publishedSha256, 'Published'); const mapping = published(descriptor, source);
        requireThat(mapping.snapshotId === pointer.snapshotId && mapping.catalogSchemaVersion === pointer.catalogSchemaVersion && mapping.catalogSha256 === pointer.catalogSha256 && mapping.catalogSizeBytes === pointer.catalogSizeBytes, 'PublishedMismatch');
        trace.event('publication.verified', { snapshot: pointer.snapshotId, sha256: pointer.catalogSha256 });
        return metadataResponse(raw, request, trace, true, metadataNoStore || env.POC_MODE === 'true', origin.metadataAgeSeconds);
      }
      const descriptorRaw = await origin.file(source, commit, 'published/' + path.snapshot + '.json'); const descriptor = published(descriptorRaw, source);
      requireThat(descriptor.snapshotId === path.snapshot, 'SnapshotMismatch');
      if (path.kind === 'published') {
        await verifyBytes(descriptorRaw, descriptorRaw.byteLength, path.hash, 'Published'); return metadataResponse(descriptorRaw, request, trace, false, metadataNoStore || env.POC_MODE === 'true', origin.metadataAgeSeconds);
      }
      const identity = { ...descriptor, sizeBytes: descriptor.catalogSizeBytes, sha256: descriptor.catalogSha256 };
      const loadCatalog = async () => {
        await origin.assetIdentity(identity);
        const response = await origin.bytes(identity), raw = await origin.consume(response, MAX_CATALOG);
        await catalog(raw, descriptor); return raw;
      };
      let catalogRaw;
      if (Number(seconds) > 0 && !fresh) {
        const scope = await digest(new TextEncoder().encode(env.GITHUB_TOKEN ? 'token:' + env.GITHUB_TOKEN : 'anonymous'));
        const cached = await metadataCache.read('catalog:' + scope + ':' + JSON.stringify(identity), Number(seconds) * 1000, loadCatalog, trace);
        catalogRaw = cached.bytes;
        origin.metadataAgeSeconds = Math.max(origin.metadataAgeSeconds, Math.ceil(Math.max(0, now() - cached.createdAt) / 1000));
      } else catalogRaw = await loadCatalog();
      const index = await catalog(catalogRaw, descriptor);
      trace.event('catalog.verified', { bytes: catalogRaw.byteLength, sha256: descriptor.catalogSha256 });
      if (path.kind === 'catalog') {
        requireThat(path.hash === descriptor.catalogSha256, 'CatalogDigestMismatch', 404); return metadataResponse(catalogRaw, request, trace, false, metadataNoStore || env.POC_MODE === 'true', origin.metadataAgeSeconds);
      }
      const asset = selectedPackage(index, path);
      const entry = { source: path.source, package: path.package, version: path.version, sha256: asset.sha256, sizeBytes: asset.sizeBytes };
      const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.sizeBytes), 'ETag': '"sha256-' + asset.sha256 + '"',
        'Cache-Control': 'no-store', 'X-Phinix-Request-Id': trace.id, 'X-Content-Type-Options': 'nosniff' });
      // Platform edge caching is deliberately off until cold stream failure/Range PoC passes.
      trace.event('cache.edge_bypass', { reason: 'PlatformPocPending' });
      const conditional = request.headers.get('If-None-Match');
      if (conditional === headers.get('ETag')) { trace.finish(304, 'NotModified'); return new Response(null, { status: 304, headers }); }
      if (request.method === 'HEAD') { trace.finish(200, 'ApprovedMetadata', asset.sizeBytes); return new Response(null, { headers }); }
      let body, stub;
      if (env.R2_ENABLED === 'true' && env.CACHE_COORDINATOR) {
        const id = env.CACHE_COORDINATOR.idFromName('single-bucket-ledger-v1'); stub = env.CACHE_COORDINATOR.get(id);
        try {
          const cached = await stub.fetch(new Request('https://cache.internal/get', { method: 'POST', body: JSON.stringify(entry), headers: { 'X-Phinix-Request-Id': trace.id, ...(trace.base.clientRequestId ? { 'X-Phinix-Client-Request-Id': trace.base.clientRequestId } : {}) } }));
          if (cached.status === 200) {
            if (cached.headers.get('Content-Length') !== String(asset.sizeBytes) || !cached.body) { cached.body?.cancel().catch(() => {}); throw new GatewayError('CacheLengthMismatch'); } body = cached.body;
            trace.event('cache.r2_hit', { expectedBytes: asset.sizeBytes });
          } else { trace.event('cache.r2_bypass', { status: cached.status, reason: cached.status === 404 ? 'Miss' : 'CoordinatorUnavailable' }, cached.status === 404 ? 'info' : 'warn'); if (cached.body) cached.body.cancel().catch(() => {}); }
        } catch (error) { trace.event('cache.r2_bypass', { reason: safeError(error) }, 'warn'); }
      } else trace.event('cache.r2_bypass', { reason: 'NotConfigured' });
      let writer = null;
      if (!body) {
        await origin.assetIdentity(asset, path.version); const upstream = await origin.bytes(asset); body = upstream.body;
        if (stub && asset.sizeBytes <= 8 * 1024 * 1024) writer = startFill(stub, entry, trace, context, cachePipeFactory);
        else trace.event('cache.fill_skipped', { reason: stub ? 'PocSizeLimit' : 'NotConfigured' });
      }
      trace.event('stream.headers_sent', { status: 200, expectedBytes: asset.sizeBytes });
      const verified = verifiedStream(body, asset, trace, { digestFactory, cacheWriter: writer });
      let delivered = verified;
      if (responsePipeFactory) {
        // Workers ignores manually supplied Content-Length on a generic ReadableStream.
        // Keep the verified stream's final-byte holdback before the fixed-length framing.
        const pipe = responsePipeFactory(asset.sizeBytes);
        context.waitUntil(verified.pipeTo(pipe.writable).catch(() => { /* The verified stream audits failure/cancellation. */ }));
        delivered = pipe.readable;
      }
      return new Response(delivered, { headers });
    } catch (error) { return errorResponse(error, trace, request.method === 'HEAD'); }
  } };
}
async function metadataResponse(bytes, request, trace, mutable, poc = false, age = 0) {
  const etag = '"sha256-' + await digest(bytes) + '"';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.byteLength), ETag: etag,
    'Cache-Control': poc ? 'no-store' : mutable ? 'public, max-age=0, must-revalidate, no-transform' : 'public, max-age=31536000, immutable, no-transform',
    Age: String(age), 'X-Phinix-Request-Id': trace.id, 'X-Content-Type-Options': 'nosniff' };
  const notModified = request.headers.get('If-None-Match') === etag;
  trace.finish(notModified ? 304 : 200, notModified ? 'NotModified' : 'MetadataVerified', bytes.byteLength);
  return new Response(notModified || request.method === 'HEAD' ? null : bytes, { status: notModified ? 304 : 200, headers });
}

// A temporary controlled-test gate. Production mode has no implicit credential requirement.
async function authorizePoc(request, env) {
  if (env.POC_MODE !== 'true') return;
  requireThat(typeof env.POC_EXPIRES_AT === 'string' && /^[0-9]{13}$/.test(env.POC_EXPIRES_AT), 'PocConfigurationInvalid', 503);
  requireThat(Date.now() < Number(env.POC_EXPIRES_AT), 'PocExpired', 410);
  requireThat(typeof env.POC_ACCESS_TOKEN === 'string' && /^[a-f0-9]{64}$/.test(env.POC_ACCESS_TOKEN), 'PocConfigurationInvalid', 503);
  const value = request.headers.get('Authorization') ?? '';
  requireThat(/^Bearer [a-f0-9]{64}$/.test(value), 'PocAccessDenied', 401);
  const expected = new TextEncoder().encode(env.POC_ACCESS_TOKEN), actual = new TextEncoder().encode(value.slice(7));
  let difference = 0; for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  requireThat(difference === 0, 'PocAccessDenied', 401);
}
