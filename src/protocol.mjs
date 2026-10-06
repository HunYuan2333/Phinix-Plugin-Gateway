import { validateDisplayLocalization } from "./localized-display.mjs";
import { GatewayError } from "./audit.mjs";
export const MAX_METADATA = 16384, MAX_CATALOG = 2 * 1024 * 1024, MAX_PACKAGE = 128 * 1024 * 1024;
export function requireThat(condition, code = "InvalidMetadata", status = 502) { if (!condition) throw new GatewayError(code, status); }
export function identifier(value) { requireThat(typeof value === "string" && value.length <= 128 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value), "InvalidIdentifier", 400); return value; }
export function hex(value, length = 64) { requireThat(typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value), "InvalidDigest", 400); return value; }
export function positiveId(value) { requireThat(typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n, "InvalidIdentity"); return value; }
export function apiId(value) { requireThat(Number.isSafeInteger(value) && value > 0, "InvalidOriginIdentity"); return String(value); }
export function size(value, maximum) { requireThat(Number.isSafeInteger(value) && value > 0 && value <= maximum, "InvalidSize"); return value; }
export function version(value) { requireThat(typeof value === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) && value.split('.').every(n => Number(n) <= 2147483647), "InvalidVersion", 400); return value; }
export function repository(value) { requireThat(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !/\.git$/i.test(value), "InvalidRepository"); return value; }
export function object(value, fields) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "InvalidMetadata");
  requireThat(Object.keys(value).every(key => fields.includes(key)), "UnknownField");
  requireThat(fields.every(key => Object.hasOwn(value, key)), "MissingField"); return value;
}
// JSON.parse silently accepts duplicate properties. This bounded reader rejects them before parsing numbers/strings.
export function strictJson(bytes, maximum = MAX_METADATA) {
  requireThat(bytes.byteLength > 0 && bytes.byteLength <= maximum, "DocumentLimit");
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new GatewayError("InvalidUtf8"); }
  let i = 0, nodes = 0;
  const white = () => { while (/[\x20\t\r\n]/.test(text[i] ?? "!")) i++; };
  function string() {
    requireThat(text[i] === '"', "InvalidJson"); const start = i++;
    while (i < text.length) { const c = text[i++]; if (c === '\\') { i++; continue; } if (c === '"') { try { return JSON.parse(text.slice(start, i)); } catch { break; } } }
    throw new GatewayError("InvalidJson");
  }
  function read(depth) {
    requireThat(depth <= 32 && ++nodes <= 100000, "DocumentLimit"); white(); const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; const result = Object.create(null); white(); if (text[i] === '}') { i++; return result; }
      while (i < text.length) {
        white(); const key = string(); requireThat(!Object.hasOwn(result, key), "DuplicateField");
        white(); requireThat(text[i++] === ':', "InvalidJson"); result[key] = read(depth + 1); white();
        if (text[i] === '}') { i++; return result; } requireThat(text[i++] === ',', "InvalidJson");
      }
    } else if (c === '[') {
      i++; const result = []; white(); if (text[i] === ']') { i++; return result; }
      while (i < text.length) { result.push(read(depth + 1)); white(); if (text[i] === ']') { i++; return result; } requireThat(text[i++] === ',', "InvalidJson"); }
    } else {
      const match = /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
      if (match) { i += match[0].length; const result = JSON.parse(match[0]); requireThat(typeof result !== "number" || Number.isFinite(result), "InvalidJson"); return result; }
    }
    throw new GatewayError("InvalidJson");
  }
  const result = read(0); white(); requireThat(i === text.length, "InvalidJson"); return result;
}
export async function digest(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, '0')).join(''); }
export async function verifyBytes(bytes, length, hash, role) {
  requireThat(bytes.byteLength === length, role + "SizeMismatch"); requireThat(await digest(bytes) === hash, role + "DigestMismatch");
}
const commonFields = ["schemaVersion", "sourceId", "snapshotId", "catalogSchemaVersion", "catalogSha256", "catalogSizeBytes"];
export function common(value, source) {
  requireThat(value.schemaVersion === 1 && [1, 3].includes(value.catalogSchemaVersion), "UnsupportedSchema");
  requireThat(value.sourceId === source, "SourceMismatch"); identifier(value.sourceId); hex(value.snapshotId, 40); hex(value.catalogSha256); size(value.catalogSizeBytes, MAX_CATALOG);
}
export function stable(bytes, source) {
  const value = object(strictJson(bytes), [...commonFields, "publishedSha256", "publishedSizeBytes"]);
  common(value, source); hex(value.publishedSha256); size(value.publishedSizeBytes, MAX_METADATA); return value;
}
export function published(bytes, sourceConfig) {
  const value = object(strictJson(bytes), [...commonFields, "repository", "repositoryId", "ownerId", "releaseId", "assetId", "assetName"]);
  common(value, sourceConfig.sourceId); repository(value.repository);
  for (const key of ["repositoryId", "ownerId", "releaseId", "assetId"]) positiveId(value[key]);
  requireThat(value.repository === sourceConfig.repository && value.repositoryId === sourceConfig.repositoryId && value.ownerId === sourceConfig.ownerId, "SourceIdentityMismatch");
  requireThat(value.assetName === "catalog.json", "InvalidCatalogAsset"); return value;
}
export async function catalog(bytes, descriptor) {
  await verifyBytes(bytes, descriptor.catalogSizeBytes, descriptor.catalogSha256, "Catalog");
  const value = object(strictJson(bytes, MAX_CATALOG), ["schemaVersion", "sourceId", "snapshotId", "packages"]);
  requireThat(value.schemaVersion === descriptor.catalogSchemaVersion && value.sourceId === descriptor.sourceId && value.snapshotId === descriptor.snapshotId, "CatalogIdentityMismatch");
  requireThat(Array.isArray(value.packages) && value.packages.length <= 1024, "CollectionLimit");
  if(value.schemaVersion === 3) for(const record of value.packages) {
    requireThat(record && typeof record === "object" && !Array.isArray(record), "InvalidMetadata");
    if(record.channel === "github-release") {
      requireThat(!Object.hasOwn(record,"name") && !Object.hasOwn(record,"summary"), "UnexpectedField");
      validateDisplayLocalization(record.localization);
    } else requireThat(record.channel === "steam-workshop" && !Object.hasOwn(record,"localization"), "UnsupportedRoute");
  }
  return value;
}
export function route(request) {
  const url = new URL(request.url);
  requireThat(request.method === "GET" || request.method === "HEAD", "MethodNotAllowed", 405);
  requireThat(!request.headers.has("Range"), "RangeNotSupported", 416);
  requireThat(!request.url.includes('?') && !request.url.includes('#') && !url.pathname.includes('%') && url.pathname.length <= 1024, "InvalidPath", 400);
  const parts = url.pathname.split('/');
  requireThat(parts[0] === '' && parts[1] === 'v1' && parts[2] === 'sources', "RouteNotFound", 404);
  const source = identifier(parts[3]);
  if (parts.length === 5 && parts[4] === 'stable') return { source, kind: 'stable' };
  requireThat(parts[4] === 'snapshots', "RouteNotFound", 404); const snapshot = hex(parts[5], 40);
  if (parts.length === 8 && ['published', 'catalog'].includes(parts[6])) return { source, snapshot, kind: parts[6], hash: hex(parts[7]) };
  requireThat(parts.length === 11 && parts[6] === 'packages' && parts[10] === 'package', "RouteNotFound", 404);
  return { source, snapshot, kind: 'package', package: identifier(parts[7]), version: version(parts[8]), hash: hex(parts[9]) };
}
export function sources(env) {
  const input = typeof env.SOURCES === "string" ? strictJson(new TextEncoder().encode(env.SOURCES)) : env.SOURCES;
  requireThat(Array.isArray(input) && input.length > 0 && input.length <= 8, "InvalidConfiguration", 503);
  const result = new Map();
  for (const value of input) {
    object(value, ["sourceId", "repository", "repositoryId", "ownerId", "publicationBranch"]);
    identifier(value.sourceId); repository(value.repository); positiveId(value.repositoryId); positiveId(value.ownerId);
    requireThat(typeof value.publicationBranch === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/.test(value.publicationBranch) && value.publicationBranch.length <= 128 && !value.publicationBranch.includes('..') && !value.publicationBranch.endsWith('.') && !result.has(value.sourceId), "InvalidConfiguration", 503);
    result.set(value.sourceId, value);
  }
  return result;
}
export function selectedPackage(index, path) {
  const managed = index.schemaVersion === 3;
  requireThat(managed || index.schemaVersion === 1, "UnsupportedSchema");
  const matches = index.packages.filter(p => p && p.id === path.package && (managed ? p.manifest?.version : p.version) === path.version);
  requireThat(matches.length === 1, "PackageNotFound", 404); const record = matches[0];
  requireThat(record.state === 'active', "PackageUnavailable", 410);
  requireThat(record.channel === 'github-release' && record.artifact?.payloadKind === (managed ? 'managed-dll-zip' : 'rimworld-mod-zip'), "PayloadNotSupported", 422);
  if (managed) requireThat(record.management === 'phinix-dll' && record.manifest?.schemaVersion === 1 && record.manifest.management === 'phinix-dll' && record.manifest.packageId === record.id, 'ManagedIdentityMismatch');
  const a = object(record.artifact, ["repository", "repositoryId", "ownerId", "sourceCommit", "tag", "releaseId", "assetId", "assetName", "payloadKind", "sha256", "manifestSha256", "sizeBytes"]);
  repository(a.repository); for (const key of ['repositoryId', 'ownerId', 'releaseId', 'assetId']) positiveId(a[key]);
  hex(a.sourceCommit, 40); hex(a.sha256); hex(a.manifestSha256); size(a.sizeBytes, MAX_PACKAGE);
  requireThat(a.sha256 === path.hash, "ArtifactDigestMismatch", 404);
  requireThat(a.tag === path.version || a.tag === 'v' + path.version, "ArtifactIdentityMismatch");
  requireThat(typeof a.assetName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.zip$/.test(a.assetName) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(a.assetName), "InvalidAssetName");
  return a;
}
