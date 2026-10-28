/**
 * Config reading for the MCP discovery server.
 *
 * Reads `%LOCALAPPDATA%\Toros\config.json` once (same path rule as Node Core's
 * `configPath()` but without the argv override), strips a BOM, and returns the
 * Node Core `port` and the agent token at `agents.<agent>.token`. A missing
 * file, a missing/non-string token, or a bad port is a start-up failure whose
 * message names the field and never the value.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentName = 'claude' | 'codex';

export interface McpConfig {
  readonly port: number;
  readonly token: string;
}

/** The fixed config path, matching Node Core's `configPath()`. */
export function configPath(): string {
  const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  return join(local, 'Toros', 'config.json');
}

/**
 * Read and validate the config for one agent. Throws on any start-up failure;
 * the error message names the field, never the value.
 */
export async function readConfig(path: string, agent: AgentName): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw new Error(`Toros config file could not be read: ${path}`);
  }

  let config: unknown;
  try {
    config = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new Error('Toros config file is not valid JSON');
  }

  const record = (typeof config === 'object' && config !== null && !Array.isArray(config))
    ? (config as Record<string, unknown>)
    : null;
  if (record === null) throw new Error('Toros config must be a JSON object');

  const port = record['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Toros config: port must be an integer between 1 and 65535');
  }

  const agents = record['agents'];
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    throw new Error(`Toros config: agents.${agent}.token is missing`);
  }
  const entry = (agents as Record<string, unknown>)[agent];
  const token = (typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    ? (entry as Record<string, unknown>)['token']
    : undefined;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`Toros config: agents.${agent}.token must be a non-empty string`);
  }

  return { port, token };
}