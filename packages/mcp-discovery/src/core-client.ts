/**
 * The HTTP client to Node Core (`/agent/*`), loopback only.
 *
 * Each request gets its own socket (`agent: false`), sends the agent bearer as
 * `Authorization: Bearer <token>`, enforces the 1 MiB result cap while reading
 * (refusing rather than truncating), and destroys that request's socket on
 * abort. A connection error is reported with a fixed, token-free message.
 */

import { request } from 'node:http';

import {
  NODE_CORE_DEADLINE,
  RESULT_EXCEEDS_CAP,
  type CallResult,
  type CoreCall,
} from './protocol.js';

/** The maximum Node Core response body, in bytes, before it is refused. */
export const RESULT_CAP_BYTES = 1024 * 1024;

export interface CoreClientOptions {
  readonly host?: string;
  readonly port: number;
  readonly token: string;
}

/**
 * Build the `call` function the protocol layer uses. It performs one POST to
 * `127.0.0.1:<port>` with the agent bearer and resolves to a `CallResult`, or
 * throws a tagged object (`{ code }`) for the deadline, the result cap, or a
 * connection failure. The abort signal is honoured by destroying the request
 * socket, so a deadline closes the underlying connection.
 */
export function createCoreClient(options: CoreClientOptions): CoreCall {
  const host = options.host ?? '127.0.0.1';
  const port = options.port;
  const token = options.token;

  return (route: string, body: unknown, signal: AbortSignal): Promise<CallResult> => {
    const payload = JSON.stringify(body);

    return new Promise<CallResult>((resolve, reject) => {
      const req = request({
        host,
        port,
        path: route,
        method: 'POST',
        agent: false, // each request its own socket
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      });

      // Deadline: destroy this request's socket so a hung Core cannot keep the
      // connection open past the MCP deadline.
      const onAbort = (): void => {
        rejected('node_core_deadline');
        req.destroy();
      };

      let settled = false;
      function finish(result: CallResult): void {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      }
      function rejected(code: string): void {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        const error: { code: string } = { code };
        reject(error as never);
      }

      if (signal.aborted) {
        rejected(NODE_CORE_DEADLINE);
        return;
      }
      signal.addEventListener('abort', onAbort);

      req.on('error', () => {
        // A connection error (Core not running) or a local abort both surface
        // here. After an abort the client reports the deadline; otherwise the
        // short connection-failure text.
        rejected(signal.aborted ? NODE_CORE_DEADLINE : 'connection_failed');
      });

      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let total = 0;
        let tooLarge = false;

        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > RESULT_CAP_BYTES) {
            tooLarge = true;
            // Refuse rather than truncate: destroy and report the cap error.
            res.destroy();
            rejected(RESULT_EXCEEDS_CAP);
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (tooLarge) return;
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try { parsed = JSON.parse(text); } catch { parsed = null; }
          finish({ status, text, body: parsed });
        });

        res.on('error', () => {
          rejected(signal.aborted ? NODE_CORE_DEADLINE : 'connection_failed');
        });
      });

      req.end(payload);
    });
  };
}