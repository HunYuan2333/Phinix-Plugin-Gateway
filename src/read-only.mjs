import { createGateway } from './gateway.mjs';
import { requireThat } from './protocol.mjs';

// Public read-only repository adapter: no bucket, ledger or operations exports.
export function createReadOnlyGateway(options = {}) {
  return createGateway({ ...options, metadataNoStore: true, beforeOrigin: async (request, env, trace) => {
    requireThat(env.REPOSITORY_ENABLED === 'true', 'RepositoryClosed', 503);
    requireThat(env.POC_MODE === 'false' && env.R2_ENABLED === 'false' && !env.PACKAGES && !env.CACHE_COORDINATOR,
      'ReadOnlyConfigurationInvalid', 503);
    requireThat(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0 && env.GITHUB_TOKEN.length <= 256 &&
      !/\s/.test(env.GITHUB_TOKEN), 'OriginCredentialsMissing', 503);
    requireThat(env.REQUEST_LIMITER && typeof env.REQUEST_LIMITER.limit === 'function', 'RepositoryLimiterUnavailable', 503);
    // One fixed key bounds aggregate repository traffic at each Cloudflare location.
    // This is eventually consistent throttling, not a global billing/quota ledger.
    const result = await env.REQUEST_LIMITER.limit({ key: 'phinix-repository-read-only' });
    requireThat(result && typeof result.success === 'boolean', 'RepositoryLimiterUnavailable', 503);
    requireThat(result.success, 'RepositoryRateLimited', 429);
    trace.event('repository.read_admitted');
  } });
}

export default createReadOnlyGateway();
