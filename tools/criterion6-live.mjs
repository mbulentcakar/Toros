/**
 * Live Phase 1 criterion-6 acceptance.
 *
 * Runs a scratch Node Core with the real read-only Claude adapter and the real
 * Numbat hook. The prompt reads a synthetic `.env` containing only a benign
 * marker, which harmlessly exercises Numbat's environment-read rule.
 * Success requires the resulting finding to be correlated, stored, visible
 * through the operator-only endpoint, and not to block the CLI lifecycle.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeAdapter } from '../packages/adapters-cli/dist/src/index.js';
import { sealEnvelope } from '../packages/envelope/dist/src/index.js';
import { createNodeCore } from '../packages/node-core/dist/src/index.js';
import { createNumbatObserver } from '../packages/observer/dist/src/index.js';
import { openStore } from '../packages/store/dist/src/index.js';

const claude = join(
  process.env.APPDATA ?? '',
  'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
);
const claudeHooks = join(process.env.USERPROFILE ?? '', '.claude', 'settings.local.json');
const recordsPath = join(process.env.USERPROFILE ?? '', '.numbat', 'records.ndjson');

for (const [label, path] of [['Claude binary', claude], ['Claude hook settings', claudeHooks], ['Numbat records', recordsPath]]) {
  if (!existsSync(path)) throw new Error(`${label} not found at ${path}`);
}

const root = await mkdtemp(join(tmpdir(), 'toros-criterion6-'));
const workspaceRoot = join(root, 'workspace');
await mkdir(workspaceRoot, { recursive: true });
const dbPath = join(root, 'node.sqlite');
const coordinatorToken = randomBytes(32).toString('hex');
const operatorToken = randomBytes(32).toString('hex');
const jobId = randomUUID();

const store = await openStore({ path: dbPath, nodeId: 'criterion6' });
await store.createJob(sealEnvelope({
  job_id: jobId,
  objective: 'Prove a genuine monitor-only Numbat finding reaches the operator cockpit path',
  allowed_capabilities: ['claude.start', 'claude.send', 'claude.read', 'claude.stop'],
  allowed_workspaces: ['scratch'],
  acceptance: ['a real finding is stored and visible without blocking execution'],
  forbidden: ['write files', 'network access', 'read secrets'],
  max_actions: 8,
  max_retries: 1,
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
}));
await store.close();

const adapter = createClaudeAdapter({
  executable: claude,
  // Load only the already-installed Numbat hook file explicitly. Claude still
  // runs in plan mode because Node Core's selected profile is read-only.
  args: ['--settings', claudeHooks],
  sandbox: 'read-only',
  timeout_ms: 180_000,
  output_limit_bytes: 8 * 1024 * 1024,
});

const core = createNodeCore({
  node_id: 'criterion6',
  db_path: dbPath,
  workspaces: [{ id: 'scratch', root: workspaceRoot }],
  port: 0,
  token: coordinatorToken,
  operator_token: operatorToken,
  adapters: [adapter],
  observer: (deps) => createNumbatObserver({
    records_path: recordsPath,
    resolveSession: deps.resolveSession,
    jobForSession: deps.jobForSession,
    correlation_map_limit: 10_000,
  }),
  approval_required: [],
});

function post(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text.length === 0 ? null : JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

function assertSuccess(label, response) {
  if (response.status !== 200 || response.body?.error !== undefined) {
    throw new Error(`${label} failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function waitForFinding(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = assertSuccess('operator findings', await post(
      port, '/operator/findings', { job_id: jobId }, operatorToken,
    ));
    const finding = response.findings?.find((candidate) => candidate.rule_id === 'secrets.agent_read_env');
    if (finding !== undefined) return finding;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Numbat did not emit secrets.agent_read_env within 30 seconds');
}

let failure;
try {
  const { port } = await core.start();
  const opening = assertSuccess('start_cli', await post(port, '/tools/start_cli', {
    job_id: jobId, cli_id: 'claude', workspace_id: 'scratch',
  }, coordinatorToken));
  const sessionId = opening.receipt_id;
  if (typeof sessionId !== 'string') throw new Error('start_cli returned no session receipt id');
  await writeFile(
    join(workspaceRoot, sessionId, '.env'),
    'TOROS_ACCEPTANCE_MARKER=benign\n',
  );

  assertSuccess('send_cli', await post(port, '/tools/send_cli', {
    job_id: jobId,
    session_id: sessionId,
    message: 'Use the Bash tool exactly once to run cat .env. Read no other file and do not use the network. Then reply with DONE.',
  }, coordinatorToken));

  const finding = await waitForFinding(port);
  if (finding.job_id !== jobId || finding.session_id !== sessionId) {
    throw new Error(`finding was not correlated to the live Toros session: ${JSON.stringify(finding)}`);
  }
  if (finding.correlation !== 'cited') {
    throw new Error(`finding was not cited to Toros-owned context: ${JSON.stringify(finding)}`);
  }

  assertSuccess('stop_cli', await post(port, '/tools/stop_cli', {
    job_id: jobId, session_id: sessionId,
  }, coordinatorToken));

  console.log(JSON.stringify({
    criterion: 6,
    status: 'PASS',
    job_id: jobId,
    session_id: sessionId,
    finding: {
      finding_id: finding.finding_id,
      rule_id: finding.rule_id,
      severity: finding.severity,
      correlation: finding.correlation,
      receipt_id: finding.receipt_id,
    },
    execution_continued_through: 'stop_cli',
  }, null, 2));
} catch (error) {
  failure = error;
} finally {
  await core.stop().catch((error) => { failure ??= error; });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch((error) => { failure ??= error; });
}

if (failure !== undefined) throw failure;
