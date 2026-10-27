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

  let buffer = '';
  let overflow = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const char of chunk) {
      if (char === '\n') {
        if (overflow) {
          overflow = false;
          buffer = '';
          process.stdout.write(`${oversizedError()}\n`);
        } else {
          server.receive(buffer);
          buffer = '';
        }
        continue;
      }
      if (overflow) continue; // discard the rest of an oversized line
      buffer += char;
      if (Buffer.byteLength(buffer, 'utf8') > FRAME_CAP_BYTES) {
        overflow = true;
        buffer = '';
      }
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