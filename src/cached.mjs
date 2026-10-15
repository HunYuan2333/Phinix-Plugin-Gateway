import { createReadOnlyGateway } from './read-only.mjs';
// Account-internal DO/RPC exports; no public administration routes.
export { CacheCoordinator, RepositoryOperations } from './index.mjs';
export default createReadOnlyGateway({ allowCache: true });
