import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ErrorCode, TorosError, type JsonValue } from '@toros/contracts';

import type { RunBinding, RunCredentials } from './run-credentials.js';

const BODY_LIMIT = 1024 * 1024;

export interface HttpHelpers {
  readonly readBody: (request: IncomingMessage) => Promise<unknown>;
  readonly send: (response: ServerResponse, status: number, value: unknown) => void;
}

export interface RouteSurface {
  readonly handle: (operation: string | undefined, request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

export interface ToolRouteSurface {
  readonly has: (tool: string) => boolean;
  readonly authorize: (tool: string, mode: 'job' | 'advisory') => void;
  readonly dispatch: (tool: string, args: Readonly<Record<string, JsonValue>>, advisory?: RunBinding | null) => Promise<unknown>;
}

export interface HttpTransport {
  readonly start: (port: number) => Promise<{ readonly port: number }>;
  readonly stop: () => Promise<void>;
  readonly port: () => number | null;
}

export function toros(code: (typeof ErrorCode)[keyof typeof ErrorCode], message: string): TorosError {
  return new TorosError(code, message);
}

/**
 * Collapse values whose canonical form differs from their parsed form.
 *
 * RFC 8785 serialises `-0` as `0`, so `{"v":-0}` and `{"v":0}` produce the same
 * digest — but `JSON.parse` preserves the sign, and the adapter received
 * whichever one arrived. Every digest in this system therefore described
 * something subtly different from what ran: the same approval covered both, and
 * the same receipt attested to both.
 *
 * Normalising at the parse boundary makes the executed value equal the digested
 * value everywhere at once — approvals, retry counting, and the receipt's
 * `arguments_digest` — rather than patching each place that compares them.
 */
function normalizeParsed(value: unknown): unknown {
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map((item) => normalizeParsed(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      // `__proto__` is the one key that does not survive this rebuild as a
      // key. `JSON.parse` produces it as an ordinary own property, but
      // assigning it to a plain object sets that object's PROTOTYPE instead,
      // so the value becomes readable through `out[key]` while being invisible
      // to `Object.keys`, `Object.values`, and `JSON.stringify`.
      //
      // That splits the object in two, and this function exists to prevent
      // exactly that split. Ajv would accept the result — `required` is
      // satisfied through the prototype chain and `additionalProperties:
      // false` sees no extra own key — while the arguments digest, the
      // receipt, the operator's approval screen, and policy's forbidden-term
      // scan all read own properties and see nothing.
      //
      // Refused rather than skipped: silently dropping it would let a caller
      // satisfy a `required` field with a value that never executes. No
      // legitimate Toros argument is named `__proto__`.
      if (key === '__proto__') {
        throw toros(ErrorCode.E_SCHEMA, 'A request body may not contain a "__proto__" key');
      }
      out[key] = normalizeParsed(member);
    }
    return out;
  }
  return value;
}

export function asRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw toros(ErrorCode.E_SCHEMA, 'Arguments must be an object');
  }
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * A string array argument, or [] when absent. Non-string members are dropped
 * rather than coerced: a capsule's file list decides what leaves the machine,
 * so a malformed entry must not become a plausible-looking path.
 */
export function stringArray(args: Readonly<Record<string, JsonValue>>, name: string): readonly string[] {
  const value = args[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function requiredString(args: Readonly<Record<string, JsonValue>>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw toros(ErrorCode.E_SCHEMA, `${name} must be a non-empty string`);
  return value;
}

export function optionalString(args: Readonly<Record<string, JsonValue>>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw toros(ErrorCode.E_SCHEMA, `${name} must be a string`);
  return value;
}

export function requiredPositiveInteger(args: Readonly<Record<string, JsonValue>>, name: string, max: number): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw toros(ErrorCode.E_SCHEMA, `${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

export async function readBody(request: IncomingMessage): Promise<unknown> {
  const length = request.headers['content-length'];
  if (length !== undefined && Number(length) > BODY_LIMIT) throw new TorosError(ErrorCode.E_SCHEMA, 'Request body too large', { body_too_large: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > BODY_LIMIT) throw new TorosError(ErrorCode.E_SCHEMA, 'Request body too large', { body_too_large: true });
    chunks.push(buffer);
  }
  // Parse and normalise are separate steps so that normalisation's own
  // refusal keeps its reason. Wrapped together, a rejected `__proto__` was
  // reported as "Request body must be JSON" — a message that sends the
  // reader looking for a syntax error that is not there.
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw toros(ErrorCode.E_SCHEMA, 'Request body must be JSON'); }
  return normalizeParsed(parsed);
}

export function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

export function createHttpTransport(deps: {
  readonly token: string;
  readonly operator_token?: string;
  readonly runCredentials: RunCredentials;
  readonly tools: ToolRouteSurface;
  readonly operator: RouteSurface;
  readonly chrome: RouteSurface;
  readonly agent: RouteSurface;
}): HttpTransport {
  let server: Server | null = null;
  let actualPort = 0;

  function equalTokens(supplied: string, expected: string): boolean {
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Which run is calling the tool surface, and therefore what it may do.
   *
   * A job-bound run presents the node's coordinator bearer and reaches the
   * whole surface, as it always has. An advisory run presents its own run
   * credential instead and reaches only the advisory tools. Capability follows
   * the credential rather than a flag inside the request, so an advisory run
   * has nothing it could set to widen itself.
   *
   * The residual is the one SPEC §8.1 already states: the coordinator is an
   * ordinary process and could read the node bearer out of its own config file.
   * That limit is unchanged by this and is not confinement.
   */
  function authenticate(request: IncomingMessage, response: ServerResponse): { readonly mode: 'job' } | { readonly mode: 'advisory'; readonly run: RunBinding } | null {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const supplied = header.slice(7);
      if (equalTokens(supplied, deps.token)) return { mode: 'job' };
      const binding = deps.runCredentials.resolveAdvisory(supplied);
      if (binding !== null) return { mode: 'advisory', run: binding };
    }
    send(response, 401, { error: 'Unauthorized' });
    return null;
  }

  function authenticateAgainst(request: IncomingMessage, response: ServerResponse, expectedToken: string): boolean {
    const unauthorized = (): false => { send(response, 401, { error: 'Unauthorized' }); return false; };
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return unauthorized();
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(expectedToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return unauthorized();
    return true;
  }

  /** The advisory run behind this request's bearer, resolved fresh. */
  function advisoryRunFor(request: IncomingMessage): RunBinding | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    return deps.runCredentials.resolveAdvisory(header.slice(7));
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parts = (request.url ?? '').split('?')[0]?.split('/').filter(Boolean) ?? [];
    if (parts[0] === 'chrome-worker') { await deps.chrome.handle(parts[1], request, response); return; }
    if (request.headers.origin !== undefined) { send(response, 403, { error: 'Origin is not allowed' }); return; }
    // 405, not 404. The path exists; the method is what is wrong, and a client
    // told "no such thing" has no way to learn that.
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      send(response, 405, { error: 'Method not allowed' });
      return;
    }
    // The operator surface is NOT part of the coordinator's tool surface and
    // does not accept the coordinator's bearer. Approval is the one thing the
    // gated party must not be able to do for itself.
    if (parts[0] === 'operator') {
      const operatorToken = deps.operator_token;
      if (operatorToken === undefined || operatorToken.length === 0) {
        send(response, 401, { error: 'Unauthorized' });
        return;
      }
      // Defence in depth. Start-up (core.ts) refuses `operator_token === token`,
      // but that check and this mount read the configuration at different times.
      // If a future path ever skips the start-up validation and mounts the
      // operator surface with a shared bearer, the ordinary node bearer must
      // still be refused here — not admitted because it happens to equal the
      // operator bearer. Timing-safe, like the authenticateAgainst check below.
      const bearer = request.headers.authorization;
      if (typeof bearer === 'string' && bearer.startsWith('Bearer ') && equalTokens(bearer.slice(7), deps.token)) {
        send(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!authenticateAgainst(request, response, operatorToken)) return;
      await deps.operator.handle(parts[1], request, response);
      return;
    }
    // The agent surface (spec AT) is a third, separate bearer class: an
    // operator-granted session presents its own `agents.*.token`, matched on
    // the agent routes themselves. The node and operator bearers are refused
    // here, defence in depth like the operator branch above — timing-safe, so a
    // start-up distinctness check that is ever skipped still cannot admit them.
    if (parts[0] === 'agent') {
      const bearer = request.headers.authorization;
      if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
        const supplied = bearer.slice(7);
        if (equalTokens(supplied, deps.token)) { send(response, 401, { error: 'Unauthorized' }); return; }
        const operatorToken = deps.operator_token;
        if (operatorToken !== undefined && operatorToken.length > 0 && equalTokens(supplied, operatorToken)) { send(response, 401, { error: 'Unauthorized' }); return; }
      }
      await deps.agent.handle(parts[1], request, response);
      return;
    }
    const caller = authenticate(request, response);
    if (caller === null) return;
    const tool = parts[0] === 'tools' ? parts[1] : parts[0];
    if (tool === undefined || !deps.tools.has(tool)) { send(response, 404, { error: 'Not found' }); return; }
    try {
      deps.tools.authorize(tool, caller.mode);
      const args = asRecord(await readBody(request));
      // Re-resolve the credential AFTER the body has been read. Authentication
      // happens before that read, so a run can end while a slow request is
      // still arriving; trusting the binding captured at authentication let an
      // already-revoked run commit a write.
      const live = caller.mode === 'advisory' ? advisoryRunFor(request) : null;
      if (caller.mode === 'advisory' && live === null) {
        throw toros(ErrorCode.E_RUN_INVALID, 'The run ended before its request completed');
      }
      const result = await deps.tools.dispatch(tool, args, live);
      send(response, 200, result);
    } catch (error: unknown) {
      const e = error instanceof TorosError ? error : toros(ErrorCode.E_ADAPTER_FAILURE, 'Node Core request failed');
      const status = e.detail['body_too_large'] === true ? 413 : e.code === ErrorCode.E_PARALLEL_ACTION ? 409 : 400;
      // Carry the approval id out with the denial. Without it the coordinator
      // is told "needs approval" and has no way to name which request the
      // operator should look at.
      const approvalId = e.detail['approval_id'];
      send(response, status, { error: e.code, message: e.message, ...(typeof approvalId === 'string' ? { approval_id: approvalId, expires_at: e.detail['expires_at'] } : {}) });
    }
  }

  return {
    async start(port: number): Promise<{ readonly port: number }> {
      if (server !== null) return { port: actualPort };
      server = createServer((request, response) => { void handleHttp(request, response); });
      await new Promise<void>((resolve, reject) => {
        const active = server as Server;
        const onError = (error: Error): void => { active.off('listening', onListening); reject(error); };
        const onListening = (): void => { active.off('error', onError); resolve(); };
        active.once('error', onError);
        active.once('listening', onListening);
        active.listen(port, '127.0.0.1');
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Node Core did not receive a TCP address');
      actualPort = address.port;
      return { port: actualPort };
    },
    async stop(): Promise<void> {
      if (server === null) return;
      // close() only stops accepting NEW connections; it then waits for every
      // existing one to end. Node's fetch keeps sockets alive by default, so an
      // idle client holds the server open and the close callback never fires —
      // stop() hangs, and with it any restart. Drop the live sockets first.
      //
      // This matters beyond tests: the SPEC §10 acceptance criterion is that a
      // checkpoint survives a Node Core restart, and a stop() that does not
      // resolve makes that unreachable in practice.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
      actualPort = 0;
    },
    port: () => server === null ? null : actualPort,
  };
}
