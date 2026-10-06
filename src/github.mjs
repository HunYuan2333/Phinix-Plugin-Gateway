import { GatewayError, safeError } from './audit.mjs';
import { apiId, hex, requireThat, strictJson, digest, MAX_METADATA, MAX_CATALOG } from './protocol.mjs';

export async function boundedBody(response, limit, code = 'OriginDocumentLimit', { idleMs = 6000, totalMs = 20000 } = {}) {
  let reader; const chunks = []; let size = 0; const started = Date.now();
  try {
    const length = response.headers.get('Content-Length');
    if (length !== null) requireThat(/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= limit, code);
    requireThat(response.body !== null, 'OriginEmptyBody'); reader = response.body.getReader();
    while (true) {
      const remaining = totalMs - (Date.now() - started); requireThat(remaining > 0, 'OriginTotalTimeout', 503);
      let timer, part;
      try { part = await Promise.race([reader.read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new GatewayError('OriginBodyTimeout', 503, true)), Math.min(remaining, idleMs));
      })]); } finally { clearTimeout(timer); }
      if (part.done) break; size += part.value.byteLength; requireThat(size <= limit, code); chunks.push(part.value);
    }
    if (length !== null) requireThat(size === Number(length), 'OriginLengthMismatch');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
  } catch (error) { if (reader) reader.cancel().catch(() => {}); else response.body?.cancel().catch(() => {}); throw error; }
  finally { reader?.releaseLock(); }
}
export class GitHubOrigin {
  constructor({ fetcher = (...args) => fetch(...args), trace, token, metadataCache, metadataTtlMs = 0, fresh = false, timeoutMs = 6000, maxCalls = 24, totalMs = 20000, now = Date.now } = {}) {
    this.fetcher = fetcher; this.trace = trace; this.token = token; this.timeoutMs = timeoutMs; this.maxCalls = maxCalls; this.calls = 0; this.now = now; this.deadline = now() + totalMs;
    this.repos = new Map(); this.releases = new Map();
    this.metadataCache = metadataCache; this.metadataTtlMs = metadataTtlMs; this.fresh = fresh; this.metadataAgeSeconds = 0;
  }
  async call(url, accept, binary = false) {
    if (!binary && this.metadataCache && this.metadataTtlMs > 0 && !this.fresh) {
      requireThat(this.deadline - this.now() > 0, 'OriginTotalTimeout', 503);
      const scope = await digest(new TextEncoder().encode(this.token ? 'token:' + this.token : 'anonymous'));
      const result = await this.metadataCache.read(scope + ':' + accept + ':' + url, this.metadataTtlMs, () => this.load(url, accept, false), this.trace);
      requireThat(this.deadline - this.now() > 0, 'OriginTotalTimeout', 503);
      this.metadataAgeSeconds = Math.max(this.metadataAgeSeconds, Math.ceil(Math.max(0, this.now() - result.createdAt) / 1000));
      return result.bytes;
    }
    if (!binary && this.fresh) this.trace.event('origin.metadata_bypass', { reason: 'FreshRequested' });
    return this.load(url, accept, binary);
  }
  async load(url, accept, binary = false) {
    requireThat(++this.calls <= this.maxCalls, 'OriginCallLimit', 503);
    const remaining = this.deadline - this.now(); requireThat(remaining > 0, 'OriginTotalTimeout', 503);
    const parsed = new URL(url); const trustedApi = parsed.origin === 'https://api.github.com';
    requireThat(trustedApi || (binary && parsed.protocol === 'https:' && parsed.hostname === 'release-assets.githubusercontent.com' && !parsed.username && !parsed.password && parsed.pathname.startsWith('/github-production-release-asset/')), 'OriginRedirectRejected');
    const start = Date.now(); this.trace.event('origin.request', { originHost: parsed.hostname, attempt: this.calls, stage: binary ? 'asset' : 'metadata' });
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), Math.min(remaining, this.timeoutMs));
    let response;
    const headers = new Headers({ Accept: accept, 'User-Agent': 'Phinix-PluginStore-Gateway/0.0.1' });
    if (trustedApi) { headers.set('X-GitHub-Api-Version', '2022-11-28'); if (this.token) headers.set('Authorization', 'Bearer ' + this.token); }
    try {
      response = await this.fetcher(parsed.href, { method: 'GET', redirect: 'manual', headers, signal: abort.signal, cache: 'no-store' });
      const requestId = response.headers.get('X-GitHub-Request-Id');
      this.trace.event('origin.response', { status: response.status, durationMs: Date.now() - start, originHost: parsed.hostname,
        ...(trustedApi ? rateFields(response.headers) : {}),
        ...(requestId && /^[A-Za-z0-9:._-]{1,128}$/.test(requestId) ? { githubRequestId: requestId } : {}) });
      if (!binary) {
        if (response.status !== 200) throw new GatewayError(response.status === 404 ? 'OriginNotFound' : response.status === 429 || response.status === 403 ? 'OriginRateLimited' : 'OriginUnavailable', response.status === 404 ? 502 : 503, response.status !== 404);
        const bytes = await this.consume(response, accept.includes('raw') ? MAX_METADATA : MAX_CATALOG);
        return bytes;
      }
      // Body consumption owns the timer after the final stream has been obtained.
      return response;
    } catch (error) { response?.body?.cancel().catch(() => {}); this.trace.event('origin.failure', { reason: safeError(error), originHost: parsed.hostname }, 'warn'); throw error; }
    finally { clearTimeout(timer); }
  }
  async consume(response, limit) {
    const remaining = this.deadline - this.now(); requireThat(remaining > 0, 'OriginTotalTimeout', 503);
    return boundedBody(response, limit, 'OriginDocumentLimit', { idleMs: this.timeoutMs, totalMs: remaining });
  }
  async json(path) { return strictJson(await this.call('https://api.github.com' + path, 'application/vnd.github+json'), MAX_CATALOG); }
  async repo(repository, expectedRepoId, expectedOwnerId) {
    const key = repository + ':' + expectedRepoId + ':' + expectedOwnerId;
    if (this.repos.has(key)) return this.repos.get(key);
    const value = await this.json('/repos/' + repository);
    requireThat(value.private === false && value.visibility === 'public' && value.full_name === repository &&
      apiId(value.id) === expectedRepoId && apiId(value.owner?.id) === expectedOwnerId, 'OriginRepositoryMismatch');
    this.repos.set(key, value); this.trace.event('origin.identity_verified', { stage: 'repository' }); return value;
  }
  async publication(source) {
    await this.repo(source.repository, source.repositoryId, source.ownerId);
    const ref = await this.json('/repos/' + source.repository + '/git/ref/heads/' + source.publicationBranch);
    requireThat(ref.object?.type === 'commit', 'PublicationRefMismatch'); hex(ref.object.sha, 40);
    this.trace.event('publication.pinned', { snapshot: ref.object.sha }); return ref.object.sha;
  }
  async file(source, commit, path) {
    // Paths/ref are built from configured sources and already validated fixed IDs.
    return this.call('https://api.github.com/repos/' + source.repository + '/contents/' + path + '?ref=' + commit, 'application/vnd.github.raw+json');
  }
  async release(repository, releaseId) {
    const key = repository + ':' + releaseId;
    if (this.releases.has(key)) return this.releases.get(key);
    const value = await this.json('/repos/' + repository + '/releases/' + releaseId);
    requireThat(apiId(value.id) === releaseId && value.draft === false && value.prerelease === false, 'OriginReleaseMismatch');
    this.releases.set(key, value); return value;
  }
  async assetIdentity(identity, packageVersion = null) {
    await this.repo(identity.repository, identity.repositoryId, identity.ownerId);
    const release = await this.release(identity.repository, identity.releaseId);
    if (packageVersion !== null) {
      requireThat(release.tag_name === identity.tag, 'OriginTagMismatch');
      let ref = await this.json('/repos/' + identity.repository + '/git/ref/tags/' + identity.tag);
      // Resolve bounded annotated-tag chains, without treating target_commitish as proof.
      for (let depth = 0; ref.object?.type === 'tag' && depth < 5; depth++) {
        hex(ref.object.sha, 40); ref = await this.json('/repos/' + identity.repository + '/git/tags/' + ref.object.sha);
      }
      requireThat(ref.object?.type === 'commit' && ref.object.sha === identity.sourceCommit, 'OriginCommitMismatch');
    }
    const asset = await this.json('/repos/' + identity.repository + '/releases/assets/' + identity.assetId);
    requireThat(apiId(asset.id) === identity.assetId && asset.name === identity.assetName && asset.state === 'uploaded' &&
      Number.isSafeInteger(asset.size) && asset.size === identity.sizeBytes, 'OriginAssetMismatch');
    requireThat(Array.isArray(release.assets) && release.assets.some(a => apiId(a.id) === identity.assetId && a.name === identity.assetName && a.size === identity.sizeBytes), 'OriginAssetMembershipMismatch');
    if (asset.digest != null) requireThat(asset.digest === 'sha256:' + identity.sha256, 'OriginDigestMismatch');
    this.trace.event('origin.identity_verified', { stage: 'asset', expectedBytes: identity.sizeBytes });
  }
  async bytes(identity) {
    let url = 'https://api.github.com/repos/' + identity.repository + '/releases/assets/' + identity.assetId;
    for (let hop = 0; hop <= 5; hop++) {
      const response = await this.call(url, 'application/octet-stream', true);
      try {
      if (response.status === 200) {
        const encoding = response.headers.get('Content-Encoding'), contentType = response.headers.get('Content-Type')?.split(';')[0];
        const length = response.headers.get('Content-Length');
        requireThat(!encoding && !response.headers.has('Content-Range') && (contentType === 'application/octet-stream' || contentType === 'application/zip'), 'OriginResponseType');
        requireThat(length === String(identity.sizeBytes) && response.body, 'OriginLengthMismatch'); return response;
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) throw new GatewayError('OriginAssetUnavailable', 503, true);
      const location = response.headers.get('Location'); requireThat(location && hop < 5, 'OriginRedirectLimit');
      // Never log the Location/signed query, and never forward Authorization off api.github.com.
      const next = new URL(location, url);
      requireThat(next.protocol === 'https:' && next.hostname === 'release-assets.githubusercontent.com' && !next.username && !next.password && next.pathname.startsWith('/github-production-release-asset/'), 'OriginRedirectRejected');
      if (response.body) response.body.cancel().catch(() => {});
      this.trace.event('origin.redirect', { attempt: hop + 1, originHost: next.hostname }); url = next.href;
      } catch (error) { response.body?.cancel().catch(() => {}); throw error; }
    }
    throw new GatewayError('OriginRedirectLimit');
  }
}
function rateFields(headers) {
  const fields = {};
  for (const [header, key, maximum] of [['X-RateLimit-Remaining', 'rateLimitRemaining', 1000000000],
    ['X-RateLimit-Reset', 'rateLimitReset', 9999999999], ['Retry-After', 'retryAfterSeconds', 86400]]) {
    const raw = headers.get(header);
    if (/^(0|[1-9][0-9]{0,9})$/.test(raw ?? '') && Number(raw) <= maximum) fields[key] = Number(raw);
  }
  return fields;
}
