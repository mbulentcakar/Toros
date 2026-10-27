/**
 * The MCP stdio protocol layer (spec AT §"MCP server").
 *
 * This module holds no I/O of its own. It is fed newline-delimited JSON-RPC
 * lines through `receive`, answers them by calling the injected `write`, and
 * reaches Node Core only through the injected `call(route, body, signal)`.
 * Everything is bounded: one frame is at most 1 MiB, at most 4 JSON-RPC ids may
 * be outstanding, and every `tools/call` runs under its own deadline. It holds
 * no policy — the tool table maps a tool name to a fixed route/capability, and
 * Node Core enforces everything even when this server is bypassed.
 */

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** The result of one POST to Node Core, as the HTTP client reports it. */
export interface CoreCallResult {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

/** A connection-level failure has no status or body. */
export interface CoreCallFailure {
  readonly status: null;
  readonly text: string;
  readonly body: null;
}

export type CallResult = CoreCallResult | CoreCallFailure;

/**
 * `call(route, body, signal)` performs one POST to Node Core. It resolves to a
 * `CallResult` describing the response, or throws an object carrying a `code`:
 * `'node_core_deadline'` when the deadline aborts it, `'result_exceeds_cap'`
 * when the response body exceeds 1 MiB, or `'connection_failed'` on a network
 * error.
 */
export type CoreCall = (route: string, body: unknown, signal: AbortSignal) => Promise<CallResult>;

export interface McpServerOptions {
  readonly call: CoreCall;
  readonly write: (frame: string) => void;
  readonly log: (line: string) => void;
  readonly deadline_ms?: number;
  readonly server_version?: string;
}

export interface McpServer {
  readonly receive: (line: string) => void;
  readonly close: () => void;
}

/** The arguments object a tool receives. */
export type ToolCallArgs = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_DEADLINE_MS = 45_000;
export const MAX_OUTSTANDING = 4;

/** The frame cap (1 MiB), measured in bytes on a complete line before parsing. */
export const FRAME_CAP_BYTES = 1024 * 1024;

/** Sentinel codes the HTTP client throws (as `{ code }`) via the `call` path. */
export const NODE_CORE_DEADLINE = 'node_core_deadline';
export const RESULT_EXCEEDS_CAP = 'result_exceeds_cap';

// ---------------------------------------------------------------------------
// Tool description text.
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTIONS = {
  toros_status: 'Read the operator-granted discovery session for this agent: the granted job, its objective, its allowed capabilities, and whether desktop discovery is enabled. It returns structure only — no control names or values, and nothing you were not granted. toros_status shows the operator grant that bounds everything else.',
  desktop_state: 'List the top-level windows of this desktop session. Metadata only: window titles appear only for applications the node and your grant both allow, and no control names or values are ever returned. Handles are single-use — on refresh_required, re-run desktop_state. A locked desktop returns session "unavailable". Everything is bounded by the operator\'s grant.',
  desktop_inspect: 'Inspect the accessibility tree of one window. Page 1 takes window_id + freshness_token (optionally depth, 1-10); page N+1 takes continuation_token alone. Provide exactly one of the two shapes. Metadata only: structure without control names or values. Handles are single-use — on refresh_required, re-run desktop_state. A locked desktop returns session "unavailable".',
  machine_inventory: 'Report which adapters and tools are ready on this node. Readiness only, no control names or values, bounded by the operator\'s grant.',
} as const;

interface ToolEntry {
  readonly description: string;
  readonly route: string;
  readonly body: Record<string, string>;
}

const TOOLS: Readonly<Record<string, ToolEntry>> = {
  toros_status: { description: TOOL_DESCRIPTIONS.toros_status, route: '/agent/status', body: {} },
  desktop_state: { description: TOOL_DESCRIPTIONS.desktop_state, route: '/agent/invoke', body: { capability: 'desktop.state' } },
  desktop_inspect: { description: TOOL_DESCRIPTIONS.desktop_inspect, route: '/agent/invoke', body: { capability: 'desktop.inspect' } },
  machine_inventory: { description: TOOL_DESCRIPTIONS.machine_inventory, route: '/agent/invoke', body: { capability: 'machine.inventory' } },
};

// ---------------------------------------------------------------------------
// A tiny validator for exactly the schema features used here.
// ---------------------------------------------------------------------------

interface SchemaNode {
  readonly type: 'object' | 'string' | 'integer';
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly minimum?: number;
  readonly maximum?: number;
}

const EMPTY_OBJECT_SCHEMA: SchemaNode = { type: 'object', additionalProperties: false, properties: {} };

const DESKTOP_INSPECT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    window_id: { type: 'string' },
    freshness_token: { type: 'string' },
    depth: { type: 'integer', minimum: 1, maximum: 10 },
    continuation_token: { type: 'string' },
  },
};

function schemaFor(tool: string): SchemaNode {
  return tool === 'desktop_inspect' ? DESKTOP_INSPECT_SCHEMA : EMPTY_OBJECT_SCHEMA;
}

function validateValue(value: unknown, schema: SchemaNode): boolean {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return false;
      if (schema.minimum !== undefined && value < schema.minimum) return false;
      if (schema.maximum !== undefined && value > schema.maximum) return false;
      return true;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const properties = schema.properties ?? {};
        if (!Object.hasOwn(properties, key)) {
          if (schema.additionalProperties === false) return false;
          continue;
        }
        if (!validateValue(record[key], properties[key]!)) return false;
      }
      for (const required of schema.required ?? []) {
        if (!(required in record)) return false;
      }
      return true;
    }
  }
}

function validateArgs(tool: string, args: unknown): boolean {
  return validateValue(args, schemaFor(tool));
}

/** `desktop_inspect` must be exactly one of the two shapes. */
function desktopInspectShape(args: ToolCallArgs): boolean {
  const hasWindow = Object.hasOwn(args, 'window_id');
  const hasFreshness = Object.hasOwn(args, 'freshness_token');
  const hasContinuation = Object.hasOwn(args, 'continuation_token');
  if (hasContinuation) {
    // Page N+1: `continuation_token` must be the **sole** key.
    return !hasWindow && !hasFreshness && !Object.hasOwn(args, 'depth') && Object.keys(args).filter((k) => k !== 'continuation_token').length === 0;
  }
  // Page 1: exactly window_id + freshness_token (both present), optionally depth.
  return hasWindow && hasFreshness;
}

// ---------------------------------------------------------------------------
// The server.
// ---------------------------------------------------------------------------

export function createMcpServer(options: McpServerOptions): McpServer {
  const call = options.call;
  const write = options.write;
  const log = options.log;
  const deadlineMs = options.deadline_ms ?? DEFAULT_DEADLINE_MS;
  const version = options.server_version ?? '0.1.0';

  let initialized = false;
  let closed = false;
  const outstanding = new Set<unknown>();
  /** In-flight tool calls keyed by id, so `close()` and `notifications/cancelled` can clean up. */
  const inflight = new Map<unknown, { timer: NodeJS.Timeout; controller: AbortController }>();

  function sendJson(value: unknown): void {
    if (closed) return;
    write(JSON.stringify(value));
  }

  function rpc(id: unknown, result: unknown): void {
    sendJson({ jsonrpc: '2.0', id, result });
  }

  function rpcError(id: unknown, code: number, message: string): void {
    sendJson({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /**
   * Map a Node Core HTTP result to a tool result's shape. `structured` is the
   * Node Core body included as `structuredContent` — but only when it is a
   * non-null, non-array object (on 200 and on the tool-error 4xx/409/413 path).
   * It is `null` here and the caller omits the `structuredContent` key entirely
   * on a 401, on a connection failure, and when the body did not parse to an
   * object (MCP 2025-06-18: `structuredContent` is an optional object, never
   * null).
   */
  function mapAnswer(result: CallResult): { text: string; structured: Record<string, unknown> | null; isError: boolean } {
    if (result.status === 200) {
      return { text: result.text, structured: asObject(result.body), isError: false };
    }
    if (result.status === 401) {
      return { text: 'Node Core refused the agent token (401)', structured: null, isError: true };
    }
    if (result.status !== null && result.status >= 400 && result.status !== 401) {
      // Tool errors (4xx/409/413) the agent should read; keep the object body.
      return { text: result.text, structured: asObject(result.body), isError: true };
    }
    // Connection failure: a tool result, never a JSON-RPC error (item 4).
    return { text: 'Node Core is not reachable', structured: null, isError: true };
  }

  /** The body only when it is a non-null, non-array object; otherwise null. */
  function asObject(body: unknown): Record<string, unknown> | null {
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
    return null;
  }

  /**
   * Perform one tool call against Node Core and answer its id. Manages the
   * outstanding set (adding `id`, removing on completion), the per-call
   * deadline, and the dropped-late-answer rule.
   */
  function performToolCall(id: unknown, tool: string, args: ToolCallArgs): void {
    const entry = TOOLS[tool] as ToolEntry;
    // Build the invocation body: the tool's fixed body plus parameters. For
    // desktop_inspect, parameters are exactly the declared schema keys present
    // in args. For desktop_state and machine_inventory, parameters is {}.
    let body: Record<string, unknown> = { ...entry.body };
    if (entry.body['capability'] === 'desktop.inspect') {
      const parameters: Record<string, unknown> = {};
      for (const key of Object.keys(DESKTOP_INSPECT_SCHEMA.properties ?? {})) {
        if (args[key] !== undefined) parameters[key] = args[key];
      }
      body = { capability: 'desktop.inspect', parameters };
    } else if (Object.hasOwn(entry.body, 'capability')) {
      body = { capability: entry.body['capability'], parameters: {} };
    }

    const controller = new AbortController();
    let settled = false;

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      outstanding.delete(id);
      inflight.delete(id);
      fn();
    }

    // The deadline owns the -32001 answer: on expiry it aborts the request
    // (whose socket the client destroys) and answers immediately, independent
    // of whether `call` ever settles. A late answer after that is dropped.
    const deadline = setTimeout(() => {
      finish(() => {
        controller.abort();
        rpcError(id, -32001, 'Node Core did not answer within 45 s');
      });
    }, deadlineMs);

    outstanding.add(id);
    inflight.set(id, { timer: deadline, controller });

    void call(entry.route, body, controller.signal)
      .then((result) => {
        // Deadline or notifications/cancelled already owns this id; a late
        // answer must not write a second frame.
        if (controller.signal.aborted) return;
        finish(() => {
          clearTimeout(deadline);
          const { text, structured, isError } = mapAnswer(result);
          const value: Record<string, unknown> = {
            content: [{ type: 'text', text }],
            isError,
          };
          // structuredContent only when the body is a non-null, non-array object.
          if (structured !== null) value['structuredContent'] = structured;
          rpc(id, value);
        });
      })
      .catch((error: unknown) => {
        const code = errorCodeOf(error);
        finish(() => {
          clearTimeout(deadline);
          if (controller.signal.aborted) {
            // The deadline (or notifications/cancelled) already owns this id; a
            // late client abort must not write a second frame.
            return;
          }
          if (code === RESULT_EXCEEDS_CAP) {
            rpcError(id, -32603, 'result exceeds 1 MiB');
          } else if (code === NODE_CORE_DEADLINE) {
            // Safe-guard: normally owned by the deadline timer above.
            rpcError(id, -32001, 'Node Core did not answer within 45 s');
          } else {
            // Connection failure is a tool result, not a JSON-RPC error (item 4).
            rpc(id, { content: [{ type: 'text', text: 'Node Core is not reachable' }], isError: true });
          }
        });
      });
  }

  function errorCodeOf(error: unknown): string | null {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code: unknown })['code'];
      return typeof code === 'string' ? code : null;
    }
    return null;
  }

  function handleInitialize(params: unknown, id: unknown): void {
    const record = (typeof params === 'object' && params !== null && !Array.isArray(params)) ? (params as Record<string, unknown>) : {};
    const versionValue = record['protocolVersion'];
    if (typeof versionValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(versionValue)) {
      rpcError(id, -32602, 'Invalid protocolVersion');
      return;
    }
    initialized = true;
    rpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'toros-discovery', version },
      instructions: 'This server is read-only discovery bounded by an operator grant: it reads desktop and machine state only, and cannot click, type, launch, or write.',
    });
  }

  /** An id is usable when present and a string or a finite number (not null). */
  function validId(value: unknown): value is string | number {
    if (typeof value === 'string') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return false;
  }

  function handleRequest(msg: Record<string, unknown>): void {
    const method = msg['method'];
    const params = msg['params'];

    // --- JSON-RPC envelope validation (item 7). -------------------------
    if (msg['jsonrpc'] !== '2.0') {
      rpcError(null, -32600, 'Invalid Request');
      return;
    }
    const hasId = Object.hasOwn(msg, 'id');
    const id = msg['id'];
    // A present id must be a string or a finite number. `null` is not valid and
    // is never counted as outstanding.
    if (hasId && !validId(id)) {
      rpcError(null, -32600, 'Invalid Request');
      return;
    }
    const isNotification = !hasId;

    if (method === undefined || typeof method !== 'string') {
      rpcError(hasId ? id : null, -32600, 'Invalid Request');
      return;
    }

    // A notifications/* method sent **with** an id is -32600.
    if (method.startsWith('notifications/') && hasId) {
      rpcError(id, -32600, 'Invalid Request');
      return;
    }

    // A message without an id is a notification: it never produces a frame,
    // whatever its method (except notifications/initialized and
    // notifications/cancelled, handled where relevant).
    if (isNotification) {
      if (method === 'notifications/cancelled') { handleCancelled(params); }
      return;
    }

    // Duplicate-id and outstanding-count checks apply to every request with an
    // id, not only tools/call.
    if (outstanding.has(id)) {
      rpcError(id, -32600, 'id already outstanding');
      return;
    }

    if (!initialized) {
      if (method === 'ping') { rpc(id, {}); return; }
      if (method === 'initialize') { handleInitialize(params, id); return; }
      if (method === 'notifications/initialized') return;
      rpcError(id, -32002, 'Server not initialized');
      return;
    }

    if (method === 'initialize') {
      rpcError(id, -32600, 'Already initialized');
      return;
    }
    if (method === 'notifications/initialized') return;
    if (method === 'ping') { rpc(id, {}); return; }
    if (method === 'tools/list') {
      const tools = Object.keys(TOOLS).map((name) => {
        const schema = schemaFor(name);
        const properties = schema.properties ?? {};
        const inputSchema: Record<string, unknown> = { type: 'object', additionalProperties: false, properties };
        if (schema.required !== undefined && schema.required.length > 0) inputSchema['required'] = schema.required;
        return {
          name,
          description: TOOLS[name]!.description,
          inputSchema,
        };
      });
      rpc(id, { tools });
      return;
    }
    if (method === 'tools/call') {
      if (outstanding.size >= MAX_OUTSTANDING) { rpcError(id, -32000, 'too many outstanding requests'); return; }
      const record = (typeof params === 'object' && params !== null && !Array.isArray(params)) ? (params as Record<string, unknown>) : {};
      const name = record['name'];
      if (typeof name !== 'string' || !Object.hasOwn(TOOLS, name)) {
        rpcError(id, -32602, `Unknown tool: ${String(name)}`);
        return;
      }
      const args = record['arguments'];
      // A missing `arguments` is treated as {}, and a non-object `arguments`
      // (array, string, null, number) is -32602. Validation always runs.
      let argsObj: ToolCallArgs;
      if (args === undefined) {
        argsObj = {};
      } else if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        rpcError(id, -32602, `Invalid arguments for ${name}`);
        return;
      } else {
        argsObj = args as ToolCallArgs;
      }
      if (!validateArgs(name, argsObj)) {
        rpcError(id, -32602, `Invalid arguments for ${name}`);
        return;
      }
      if (name === 'desktop_inspect' && !desktopInspectShape(argsObj)) {
        rpcError(id, -32602, 'desktop_inspect requires exactly one of the two shapes');
        return;
      }
      performToolCall(id, name, argsObj);
      return;
    }

    // Other methods: -32601.
    if (outstanding.size >= MAX_OUTSTANDING) { rpcError(id, -32000, 'too many outstanding requests'); return; }
    rpcError(id, -32601, `Method not found: ${method}`);
  }

  /**
   * `notifications/cancelled`: if `params.requestId` names an in-flight
   * `tools/call`, clear its timer, abort its controller (destroying that HTTP
   * request), free its outstanding slot, and write no response for that id,
   * ever. An unknown or finished `requestId` is ignored. The Node Core action
   * itself is not aborted: spec AT adds no abort hook.
   */
  function handleCancelled(params: unknown): void {
    const record = (typeof params === 'object' && params !== null && !Array.isArray(params)) ? (params as Record<string, unknown>) : {};
    const requestId = record['requestId'];
    if (!validId(requestId)) return;
    const entry = inflight.get(requestId);
    if (entry === undefined) return; // unknown or already finished
    clearTimeout(entry.timer);
    entry.controller.abort();
    outstanding.delete(requestId);
    inflight.delete(requestId);
  }

  function receive(line: string): void {
    if (closed) return;
    // Strip one trailing \r (CRLF) and ignore empty lines, matching the stdin
    // reader, so both paths agree.
    if (line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d) {
      line = line.slice(0, -1);
    }
    if (line.length === 0) return;
    let parsed: unknown = undefined;
    try {
      // Frame cap first, in bytes, before parsing: a longer line is -32600 and
      // must not grow a buffer (the caller's line reader discards the overflow).
      if (Buffer.byteLength(line, 'utf8') > FRAME_CAP_BYTES) {
        rpcError(null, -32600, 'Request frame exceeds 1 MiB');
        return;
      }
      try {
        parsed = JSON.parse(line);
      } catch {
        rpcError(null, -32700, 'Parse error');
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        rpcError(null, -32600, 'Invalid Request: not a single JSON object');
        return;
      }
      handleRequest(parsed as Record<string, unknown>);
    } catch {
      // An unexpected throw answers that id with -32603 (no detail), or id: null
      // when the frame had no usable id. The process stays alive.
      const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? (parsed as Record<string, unknown>) : undefined;
      const id = record !== undefined && validId(record['id']) ? record['id'] : null;
      sendJson({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } });
    }
  }

  function close(): void {
    closed = true;
    for (const [, entry] of inflight) {
      clearTimeout(entry.timer);
      entry.controller.abort();
    }
    inflight.clear();
    outstanding.clear();
  }

  return { receive, close };
}