const textFields = new Set(["source", "snapshot", "package", "version", "sha256", "stage", "reason", "originHost", "githubRequestId", "clientRequestId", "cache", "lease", "period", "state", "build"]);
const numberFields = new Set(["status", "durationMs", "bytes", "expectedBytes", "attempt", "usedBytes", "reservedBytes", "classA", "classB", "limit", "rows", "rateLimitRemaining", "rateLimitReset", "retryAfterSeconds", "metadataAgeSeconds"]);
export class GatewayError extends Error {
  constructor(code, status = 502, retryable = false) { super(code); this.code = code; this.status = status; this.retryable = retryable; }
}
export function safeError(error) { return error instanceof GatewayError ? error.code : error?.name === "AbortError" ? "OriginTimeout" : "InternalFailure"; }
export class Trace {
  constructor({ sink = line => console.log(line), now = Date.now, id = crypto.randomUUID(), component = "worker", build = "dev-local", clientId = null } = {}) {
    this.id = id; this.spanId = crypto.randomUUID(); this.component = component; this.sink = sink; this.now = now; this.start = now(); this.sequence = 0; this.done = false; this.events = 0;
    this.base = { build: /^[A-Za-z0-9._-]{1,64}$/.test(build) ? build : "unknown" };
    if (/^[a-f0-9]{32}$/.test(clientId ?? "")) this.base.clientRequestId = clientId;
  }
  event(event, values = {}, level = "info") {
    if (event !== "request.complete" && event !== "audit.truncated" && this.events >= 79) {
      if (this.events === 79) { this.events++; this.event("audit.truncated", { reason: "EventLimit" }, "warn"); }
      return;
    }
    this.events++;
    const record = { schemaVersion: 1, time: new Date(this.now()).toISOString(), requestId: this.id, spanId: this.spanId, component: this.component, sequence: ++this.sequence,
      level, event: /^[a-z][a-z0-9_.]{0,63}$/.test(event) ? event : "invalid_event", ...this.base };
    for (const [key, value] of Object.entries(values)) {
      if (textFields.has(key) && typeof value === "string" && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)) record[key] = value;
      if (numberFields.has(key) && Number.isSafeInteger(value) && value >= 0) record[key] = value;
    }
    // Only fixed fields; no URL/query/header/error stack or response bodies enter audit logs.
    try { this.sink(JSON.stringify(record)); } catch { /* Logging failure is not publication authority. */ }
    return record;
  }
  finish(status, reason = "Complete", bytes = 0) {
    if (this.done) return; this.done = true;
    this.event("request.complete", { status, reason, bytes, durationMs: Math.max(0, this.now() - this.start) }, status >= 400 ? "warn" : "info");
  }
}
export function errorResponse(error, trace, head = false) {
  const known = error instanceof GatewayError ? error : new GatewayError(safeError(error), 503, true);
  trace.event("request.rejected", { reason: known.code, status: known.status }, "warn");
  trace.finish(known.status, known.code);
  return new Response(head ? null : JSON.stringify({ code: known.code, retryable: known.retryable, requestId: trace.id }), {
    status: known.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Phinix-Request-Id": trace.id, "X-Content-Type-Options": "nosniff", ...(known.retryable ? { "Retry-After": "30" } : {}) }
  });
}
