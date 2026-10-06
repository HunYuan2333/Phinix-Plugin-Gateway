import { Trace, errorResponse, GatewayError } from '../src/audit.mjs';
import { strictJson, object, requireThat } from '../src/protocol.mjs';
import { boundedBody } from '../src/github.mjs';

export function createOperationsBridge({ rpcTimeoutMs = 40000, sink } = {}) {
  return {
    async fetch(request, env) {
      const trace = new Trace({ build: 'local-operations-bridge', sink });
      let timer;
      try {
        const url = new URL(request.url);
        requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/operations' && !url.search && !url.hash, 'LocalOperationsOnly', 403);
        requireThat(!request.headers.has('Origin') && !request.headers.has('Sec-Fetch-Site'), 'BrowserOperationsDenied', 403);
        requireThat(request.method === 'POST' && request.headers.get('Content-Type') === 'application/json', 'OperationsJsonRequired', 400);
        const input = object(strictJson(await boundedBody(request, 4096), 4096), ['action', 'input']);
        requireThat(input.action === 'inspect' || input.action === 'confirm', 'InvalidRecoveryAction', 400);
        // strictJson uses null-prototype maps. RPC requires ordinary serializable objects.
        const rpcInput = JSON.parse(JSON.stringify(input.input));
        trace.event('operations.rpc_started', { stage: input.action });
        const call = input.action === 'inspect' ? env.REPOSITORY_OPERATIONS.inspect(rpcInput) : env.REPOSITORY_OPERATIONS.confirmRecovery(rpcInput);
        const result = await Promise.race([call, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new GatewayError('OperationsRpcTimeout', 503, false)), rpcTimeoutMs);
        })]);
        trace.event('operations.rpc_completed', { stage: input.action, reason: result.ok ? 'OperationsResult' : result.code });
        trace.finish(result.ok ? 200 : result.status, result.ok ? 'OperationsResult' : result.code);
        return Response.json(result, { status: result.ok ? 200 : result.status, headers: { 'Cache-Control': 'no-store', 'X-Phinix-Request-Id': result.requestId } });
      } catch (error) { return errorResponse(error, trace); }
      finally { clearTimeout(timer); }
    }
  };
}
export default createOperationsBridge();
