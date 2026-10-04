/**
 * SPEC §10 acceptance, run against the DEPLOYED service.
 *
 * The unit suite proves the units; this proves the install. Everything here
 * goes over the real loopback socket with the real bearer token.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';

// Defaults to the installed config, so the documented invocation is unchanged.
// An explicit path lets the same checks run against a scratch instance BEFORE
// a deploy \u2014 which is the only way to acceptance-test a build without first
// making it the thing in production.
const configPath = process.argv[2] ?? process.env.LOCALAPPDATA + '\\Toros\\config.json';
const cfg = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));

function call(tool, args, { token = cfg.token, origin } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args);
    const req = request({
      host: '127.0.0.1', port: cfg.port, method: 'POST', path: `/tools/${tool}`, agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(origin ? { origin } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// A job whose envelope allows the Excel inspect action inside the sandbox.
const jobId = randomUUID();
const envelope = {
  job_id: jobId,
  objective: 'deploy acceptance',
  allowed_capabilities: ['excel.inspect_workbook'],
  allowed_workspaces: ['sandbox'],
  acceptance: ['acceptance run completes'],
  forbidden: ['push', 'deploy'],
  max_actions: 20,
  max_retries: 2,
  expires_at: '2030-01-01T00:00:00Z',
};

// --- seed the job directly through the store, as an operator would ----------
const { openStore } = await import('file://' + process.cwd().replace(/\\/g, '/') + '/packages/store/dist/src/index.js');
const { sealEnvelope } = await import('file://' + process.cwd().replace(/\\/g, '/') + '/packages/envelope/dist/src/index.js');
const store = await openStore({ path: cfg.db_path, nodeId: cfg.node_id });
await store.createJob(sealEnvelope(envelope));
await store.close();

// --- 2. deterministic denials ----------------------------------------------
const outOfScope = await call('invoke_app_action', {
  job_id: jobId, app_id: 'excel', action_id: 'write_range', workspace_id: 'sandbox',
  parameters: { path: 'C:\\.Code\\_toros\\workspaces\\sandbox\\a.xlsx', sheet: 'Sheet1', range: 'A1', values: [['x']] },
});
check('out-of-scope capability is denied with E_CAP_NOT_ALLOWED',
  outOfScope.body?.error === 'E_CAP_NOT_ALLOWED', outOfScope.body?.error);

const escape = await call('invoke_app_action', {
  job_id: jobId, app_id: 'excel', action_id: 'inspect_workbook', workspace_id: 'sandbox',
  parameters: { path: 'C:\\.Code\\sicil\\secret.xlsx' },
});
check('a path outside the workspace is denied with E_PATH_ESCAPE',
  escape.body?.error === 'E_PATH_ESCAPE', escape.body?.error);

const expiredId = randomUUID();
const store2 = await openStore({ path: cfg.db_path, nodeId: cfg.node_id });
await store2.createJob(sealEnvelope({ ...envelope, job_id: expiredId, expires_at: '2020-01-01T00:00:00Z' }));
await store2.close();
const expired = await call('invoke_app_action', {
  job_id: expiredId, app_id: 'excel', action_id: 'inspect_workbook', workspace_id: 'sandbox',
  parameters: { path: 'C:\\.Code\\_toros\\workspaces\\sandbox\\a.xlsx' },
});
check('an expired envelope is denied with E_EXPIRED',
  expired.body?.error === 'E_EXPIRED', expired.body?.error);

// --- 3. the pilot app exposes only its registered actions -------------------
const caps = await call('list_capabilities', { job_id: jobId });
const excelCaps = (caps.body?.capabilities ?? caps.body ?? []).filter?.((c) => String(c).startsWith('excel.')) ?? [];
check('list_capabilities is filtered to the envelope',
  Array.isArray(excelCaps) && excelCaps.length === 1 && excelCaps[0] === 'excel.inspect_workbook',
  JSON.stringify(caps.body));

// --- transport ---------------------------------------------------------------
const noAuth = await call('job_status', { job_id: jobId }, { token: 'x'.repeat(64) });
check('a wrong bearer token is rejected with 401', noAuth.status === 401, String(noAuth.status));

const withOrigin = await call('job_status', { job_id: jobId }, { origin: 'http://evil.example' });
check('a request carrying an Origin header is rejected', withOrigin.status === 403, String(withOrigin.status));

// --- 8. receipts reconstruct the sequence, with no conversation content ------
const activity = await call('list_activity', { job_id: jobId });
const receipts = activity.body?.receipts ?? [];
const events = activity.body?.events ?? [];
check('denied actions produced receipts', receipts.length >= 2, `${receipts.length} receipts`);
check('denied actions produced request+decided events', events.length >= 4, `${events.length} events`);
check('every receipt carries the envelope digest',
  receipts.length > 0 && receipts.every((r) => typeof r.envelope_digest === 'string' && r.envelope_digest.length === 64));
check('denied receipts are closed (ended_at set)',
  receipts.filter((r) => r.outcome === 'denied').every((r) => r.ended_at !== null));
check('no receipt is attributed to a human operator',
  receipts.every((r) => r.actor !== 'operator'), receipts.map((r) => r.actor).join(','));

// --- 7. the chain verifies ---------------------------------------------------
const store3 = await openStore({ path: cfg.db_path, nodeId: cfg.node_id });
const chain = await store3.verifyChain(cfg.node_id);
await store3.close();
check('verify-chain reports an unbroken chain with a matching anchor',
  chain.ok === true && chain.anchor_matches === true, JSON.stringify(chain));

// --- 4. checkpoint + relay are wired ----------------------------------------
const cp = await call('create_checkpoint', { job_id: jobId, description: 'acceptance' });
check('create_checkpoint returns a checkpoint reference',
  cp.status === 200 && cp.body !== null, JSON.stringify(cp.body).slice(0, 120));

const capsule = await call('create_local_relay', { job_id: jobId, selected_files: [], selected_outputs: [] });
check('create_local_relay produces a capsule rather than E_NOT_REGISTERED',
  capsule.status === 200 && capsule.body?.error !== 'E_NOT_REGISTERED',
  JSON.stringify(capsule.body).slice(0, 120));

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
