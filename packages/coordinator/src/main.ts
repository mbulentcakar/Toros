#!/usr/bin/env node

import { loadCoordinatorConfig } from './config.js';
import { runAdvisory, runCoordinator } from './index.js';
import { createModelTransport } from './model.js';

interface StartContext {
  readonly runToken?: string;
  readonly operatorMessage?: string;
  /** What this machine has, for an advisory run that must draft against it. */
  readonly capabilities?: readonly string[];
  readonly workspaces?: readonly string[];
  readonly agent?: string;
  readonly model?: string;
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Node Core delivers the whole start context on stdin as one JSON object: the
 * run credential and any operator clarification. Neither may travel in argv,
 * where any process listing on the machine can read it.
 */
async function readStartContext(): Promise<StartContext> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16 * 1024) throw new Error('start context exceeds 16 KiB');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};

  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('start context must be JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('start context must be a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const runToken = record['run_token'];
  const operatorMessage = record['operator_message'];
  if (runToken !== undefined && typeof runToken !== 'string') throw new Error('run_token must be a string');
  if (operatorMessage !== undefined) {
    if (typeof operatorMessage !== 'string') throw new Error('operator_message must be a string');
    if (operatorMessage.trim().length === 0) throw new Error('operator message is empty');
    if (Buffer.byteLength(operatorMessage) > 8 * 1024) throw new Error('operator message exceeds 8 KiB');
  }
  const capabilities = stringList(record['capabilities']);
  const workspaces = stringList(record['workspaces']);
  const agent = record['agent'];
  const model = record['model'];
  if (agent !== undefined && typeof agent !== 'string') throw new Error('agent must be a string');
  if (model !== undefined && typeof model !== 'string') throw new Error('model must be a string');
  return {
    ...(typeof runToken === 'string' ? { runToken } : {}),
    ...(typeof operatorMessage === 'string' ? { operatorMessage: operatorMessage.trim() } : {}),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(workspaces === undefined ? {} : { workspaces }),
    ...(typeof agent === 'string' && agent.length > 0 ? { agent } : {}),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
  };
}

async function main(): Promise<number> {
  // An advisory run holds no job, so there is no job id to take. Its
  // conversation and credential arrive over stdin like everything else.
  if (process.argv.includes('--advisory')) {
    const context = await readStartContext();
    if (context.runToken === undefined) {
      console.error('an advisory run requires a run token on stdin');
      return 2;
    }
    try {
      const loaded = await loadCoordinatorConfig();
      // An advisory run authenticates as itself, not as the node. Node Core
      // grants that credential the advisory tools and nothing else, so the
      // refusal does not depend on this process behaving.
      const config = { ...loaded, token: context.runToken, ...(context.model === undefined ? {} : { model: context.model }) };
      return runAdvisory({
        config,
        model: createModelTransport(config),
        runToken: context.runToken,
        capabilities: context.capabilities ?? [],
        workspaces: context.workspaces ?? [],
        ...(context.agent === undefined ? {} : { agent: context.agent }),
      });
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : 'Advisory run failed to start');
      return 2;
    }
  }

  const jobId = process.argv[2];
  if (jobId === undefined || jobId.length === 0 || jobId.startsWith('--')) {
    console.error('usage: hermes <job_id> | hermes --advisory');
    return 2;
  }
  const context = await readStartContext();
  try {
    const loaded = await loadCoordinatorConfig();
    const config = { ...loaded, ...(context.model === undefined ? {} : { model: context.model }) };
    return runCoordinator({
      jobId,
      config,
      model: createModelTransport(config),
      ...(context.operatorMessage === undefined ? {} : { operatorMessage: context.operatorMessage }),
      ...(context.runToken === undefined ? {} : { runToken: context.runToken }),
    });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Coordinator failed to start');
    return 2;
  }
}

process.exitCode = await main();
