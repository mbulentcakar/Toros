import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CoordinatorConfig {
  readonly port: number;
  readonly token: string;
  readonly model: string;
  readonly base_url: string;
  readonly api_key: string;
  readonly temperature: number;
  readonly max_turns: number;
}

export interface ConfigLoadOptions {
  readonly localAppData?: string;
  readonly read?: (path: string, encoding: BufferEncoding) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

export async function loadCoordinatorConfig(options: ConfigLoadOptions = {}): Promise<CoordinatorConfig> {
  const localAppData = options.localAppData ?? process.env['LOCALAPPDATA'];
  if (localAppData === undefined || localAppData.length === 0) {
    throw new Error('LOCALAPPDATA is required');
  }
  const path = join(localAppData, 'Toros', 'coordinator.json');
  const text = await (options.read ?? readFile)(path, 'utf8');
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('coordinator.json must contain an object');

  const port = value['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  const temperature = value['temperature'] ?? 0;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    throw new Error('temperature must be a finite number');
  }
  const maxTurns = value['max_turns'] ?? 40;
  if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error('max_turns must be a positive integer');
  }

  return {
    port,
    token: requiredString(value, 'token'),
    model: requiredString(value, 'model'),
    base_url: requiredString(value, 'base_url'),
    api_key: requiredString(value, 'api_key'),
    temperature,
    max_turns: maxTurns,
  };
}
