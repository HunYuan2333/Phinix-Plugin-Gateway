// Miniflare-only fault fixture. Never an entrypoint in any deployment config.
import { CacheCoordinator } from '../.wrangler/dry-run/index.js';
export class RecoveryFaultCoordinator extends CacheCoordinator {
  async loseAcknowledgement(entry) {
    const bucket = this.env.PACKAGES;
    this.core.env = { ...this.env, PACKAGES: {
      list: options => bucket.list(options), get: key => bucket.get(key), delete: key => bucket.delete(key),
      put: async (key, body, options) => {
        const result = await bucket.put(key, body, options);
        if (!key.startsWith('__phinix/')) throw Error('Injected lost acknowledgement');
        return result;
      }
    } };
    const response = await this.core.fetch(new Request('https://cache.internal/put', { method: 'POST', body: 'native recovery proof', headers: { 'X-Phinix-Cache-Entry': JSON.stringify(entry) } }));
    this.core.now = () => Date.now() + 31000; this.core.ledger.now = this.core.now;
    return { status: response.status };
  }
}
export default {
  async fetch(request, env) {
    const stub = env.CACHE_COORDINATOR.get(env.CACHE_COORDINATOR.idFromName('native-recovery-test'));
    const input = await request.json(), path = new URL(request.url).pathname;
    if (path === '/lose-ack') return Response.json(await stub.loseAcknowledgement(input));
    if (path === '/inspect') return Response.json(await stub.inspect(input));
    if (path === '/confirm') return Response.json(await stub.confirmRecovery(input));
    if (path === '/get') return stub.fetch(new Request('https://cache.internal/get', { method: 'POST', body: JSON.stringify(input) }));
    return new Response(null, { status: 404 });
  }
};
