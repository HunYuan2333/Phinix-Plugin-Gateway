import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { CacheCoordinatorCore } from './cache-coordinator.mjs';
import { createGateway } from './gateway.mjs';
export class CacheCoordinator extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new CacheCoordinatorCore(ctx.storage, env); }
  fetch(request) { return this.core.fetch(request); }
  inspect(input) { return this.core.operations.run('inspect', input); }
  confirmRecovery(input) { return this.core.operations.run('confirm', input); }
}
// Account-internal service binding only; the public fetch handler has no operations route.
export class RepositoryOperations extends WorkerEntrypoint {
  async inspect(input) { return await operationsTarget(this.env).inspect(input); }
  async confirmRecovery(input) { return await operationsTarget(this.env).confirmRecovery(input); }
}
function operationsTarget(env) {
  return env.CACHE_COORDINATOR.get(env.CACHE_COORDINATOR.idFromName('single-bucket-ledger-v1'));
}
export default createGateway();
