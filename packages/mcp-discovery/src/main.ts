/**
 * The launch entry for the MCP discovery server.
 *
 * Order (spec AT): validate argv first (exactly `['--agent', 'claude'|'codex']`,
 * anything else writes one stderr line and exits 2 before reading any config),
 * read the config, then wire stdin line-reading to `receive` and `write` to
 * stdout. stdout carries frames only; diagnostics go to stderr through `log`.
 */

import { configPath, readConfig, type AgentName } from './config.js';
import { createCoreClient } from './core-client.js';
import { createMcpServer, FRAME_CAP_BYTES } from './protocol.js';

function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 1. Validate argv before reading any config.
  const agent: AgentName | null = argv.length === 2 && argv[0] === '--agent' && (argv[1] === 'claude' || argv[1] === 'codex')
    ? (argv[1] as AgentName)
    : null;
  if (agent === null) {
    stderr('usage: node packages/mcp-discovery/dist/src/main.js --agent claude|codex');
    process.exit(2);
  }

  // 2. Read the config.
  let config;
  try {
    config = await readConfig(configPath(), agent);
  } catch (error: unknown) {
    stderr(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  // 3. Wire stdin to receive, stdout to write. The reader enforces the 1 MiB
  // frame cap while reading: once a line exceeds the cap it stops accumulating
  // and discards the rest up to the next newline, so an enormously long line
  // cannot grow the buffer unbounded.
  const log = (line: string): void => { stderr(line); };
  const call = createCoreClient({ port: config.port, token: config.token });
  const server = createMcpServer({
    call,
    write: (frame: string): void => {
      process.stdout.write(`${frame}\n`);
    },
    log,
  });

  const oversizedError = (): string => JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request frame exceeds 1 MiB' } });

  // A buffer-based stdin line reader (O(n), not O(n²)). stdin is read as raw
  // Buffers (no setEncoding); for the current line we keep a list of chunk
  // Buffers and a running byte count, find 0x0A with indexOf, and once the count
  // passes FRAME_CAP_BYTES we drop the retained bytes, set overflow, and skip
  // until the next 0x0A. A complete line is decoded from UTF-8 exactly once.
  // One trailing `\r` (CRLF) is stripped before the cap comparison, and empty
  // lines (after stripping `\r`) produce no frame.
  const lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let overflow = false;

  process.stdin.on('data', (chunk: Buffer) => {
    let offset = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, offset);
      if (nl === -1) {
        // No newline in the rest of the chunk: retain what remains.
        if (!overflow) {
          const rest = chunk.subarray(offset);
          lineChunks.push(rest);
          lineBytes += rest.length;
          // An exact-cap line ending in CRLF can arrive as payload + \r in one
          // write and the \n later. Without a newline yet we allow one extra
          // byte when that byte is a trailing 0x0d; any other byte past the cap
          // (or a second byte) is overflow.
          const last = rest.length > 0 ? rest[rest.length - 1] : -1;
          if (lineBytes > FRAME_CAP_BYTES + 1 || (lineBytes === FRAME_CAP_BYTES + 1 && last !== 0x0d)) {
            overflow = true;
            lineChunks.length = 0;
            lineBytes = 0;
          }
        }
        return;
      }
      // A newline at `nl` ends a line of `chunk.subarray(offset, nl)`.
      const piece = chunk.subarray(offset, nl);
      offset = nl + 1;
      if (overflow) {
        overflow = false;
        lineChunks.length = 0;
        lineBytes = 0;
        // Skip the (already-discarded) remainder of the oversized line and
        // answer exactly one -32600 for it.
        process.stdout.write(`${oversizedError()}\n`);
        continue;
      }
      lineChunks.push(piece);
      lineBytes += piece.length;
      // Strip one trailing \r (CRLF) before the cap comparison.
      let complete = Buffer.concat(lineChunks, lineBytes);
      lineChunks.length = 0;
      lineBytes = 0;
      if (complete.length > 0 && complete[complete.length - 1] === 0x0d) {
        complete = complete.subarray(0, complete.length - 1);
      }
      if (complete.length === 0) continue; // ignore empty lines
      if (complete.length > FRAME_CAP_BYTES) {
        process.stdout.write(`${oversizedError()}\n`);
        continue;
      }
      const line = complete.toString('utf8');
      server.receive(line);
    }
  });

  async function shutdown(): Promise<void> {
    server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());

  log(`toros-discovery started for agent ${agent}`);
}

void main();