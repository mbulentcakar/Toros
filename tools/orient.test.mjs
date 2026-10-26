/**
 * Spec AP acceptance. Run with `node --test tools/`.
 *
 * These cover the criteria that are properties of the program rather than of
 * the machine it runs on: classification, validation, redaction, and the
 * absence of any path from configuration to an executed argument vector.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  BLOCK, OK, WARN,
  AGENT_FAMILIES,
  classifyExecutable,
  findNativeExecutable,
  parseArgs,
  parseConfigText,
  parseShimTarget,
  readVersion,
  resolveOnPath,
  classifyExchange,
  scrubOrThrow,
  validateNodeConfig,
} from './orient.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIENT = join(REPO_ROOT, 'tools', 'orient.mjs');

const scratchRoots = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'toros-orient-'));
  scratchRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

/** A configuration Node Core accepts, as the baseline every negative case perturbs. */
function goodConfig(root) {
  return {
    node_id: 'test',
    db_path: join(root, 'toros.db'),
    port: 8787,
    token: 'a'.repeat(64),
    operator_token: 'b'.repeat(64),
    workspaces: [{ id: 'sandbox', root }],
    adapters: {},
    approval_required: [],
  };
}

const blockers = (findings) => findings.filter((f) => f.level === BLOCK);

describe('executable classification (criterion 4)', () => {
  it('accepts a real .exe', () => {
    assert.equal(classifyExecutable('C:\\tools\\codex.exe'), 'usable');
  });

  it('accepts the Node runtime itself, which the adapter allows explicitly', () => {
    assert.equal(classifyExecutable('/opt/node', { nodePath: '/opt/node' }), 'usable');
  });

  it('classifies a .cmd as a shim, not as usable', () => {
    assert.equal(classifyExecutable('C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd'), 'shim');
    assert.equal(classifyExecutable('C:\\x\\claude.BAT'), 'shim');
  });

  it('rejects anything else', () => {
    assert.equal(classifyExecutable('C:\\x\\codex.js'), 'not-exe');
    assert.equal(classifyExecutable(''), 'absent');
    assert.equal(classifyExecutable(undefined), 'absent');
  });
});

describe('shim resolution', () => {
  it('finds a native executable nested under a per-platform package', () => {
    const root = scratch();
    const pkg = join(root, 'node_modules', '@openai', 'codex');
    const nested = join(pkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'triple', 'bin');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(pkg, 'bin', 'codex.js'), '// entry');
    writeFileSync(join(nested, 'codex.exe'), 'MZ');

    const shim = '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
    const parsed = parseShimTarget(shim, root, 'codex');
    assert.equal(parsed.native, join(nested, 'codex.exe'));
    assert.equal(parsed.jsEntry, join(pkg, 'bin', 'codex.js'));
  });

  it('reports the JS entry when the package ships no native binary', () => {
    const root = scratch();
    const pkg = join(root, 'node_modules', 'thing', 'bin');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'thing.js'), '// entry');

    const parsed = parseShimTarget('"%dp0%\\node_modules\\thing\\bin\\thing.js" %*', root, 'thing');
    assert.equal(parsed.native, null);
    assert.equal(parsed.jsEntry, join(pkg, 'thing.js'));
  });

  it('refuses a shim that points outside its own directory', () => {
    const root = scratch();
    assert.equal(parseShimTarget('"C:\\node_modules\\..\\..\\evil\\x.js"', join(root, 'inner'), 'x'), null);
  });

  it('prefers a bin/ hit over one found elsewhere', () => {
    const root = scratch();
    mkdirSync(join(root, 'vendor'), { recursive: true });
    mkdirSync(join(root, 'deep', 'bin'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'tool.exe'), 'MZ');
    writeFileSync(join(root, 'deep', 'bin', 'tool.exe'), 'MZ');
    assert.equal(findNativeExecutable(root, 'tool'), join(root, 'deep', 'bin', 'tool.exe'));
  });

  it('stops rather than crawling an unbounded tree', () => {
    const root = scratch();
    let path = root;
    for (let depth = 0; depth < 12; depth += 1) {
      path = join(path, `d${depth}`);
      mkdirSync(path);
    }
    writeFileSync(join(path, 'tool.exe'), 'MZ');
    assert.equal(findNativeExecutable(root, 'tool', { maxDepth: 3 }), null);
  });
});

describe('node configuration validation (criterion 7)', () => {
  const exists = () => true;

  it('accepts a configuration Node Core accepts', () => {
    const root = scratch();
    assert.deepEqual(blockers(validateNodeConfig(goodConfig(root), { exists })), []);
  });

  it('rejects a short token', () => {
    const config = { ...goodConfig(scratch()), token: 'short' };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /`token`/);
  });

  it('rejects an operator token equal to the coordinator token', () => {
    const shared = 'c'.repeat(64);
    const config = { ...goodConfig(scratch()), token: shared, operator_token: shared };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /must differ/);
  });

  it('requires an operator token once a capability is gated', () => {
    const config = { ...goodConfig(scratch()), approval_required: ['excel.write_range'] };
    delete config.operator_token;
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /required when `approval_required`/);
  });

  it('accepts a missing operator token as a warning when nothing is gated', () => {
    const config = goodConfig(scratch());
    delete config.operator_token;
    const found = validateNodeConfig(config, { exists });
    assert.deepEqual(blockers(found), []);
    assert.ok(found.some((f) => f.level === WARN && /`operator_token` is not set/.test(f.title)));
  });

  it('rejects an empty workspace list', () => {
    const config = { ...goodConfig(scratch()), workspaces: [] };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /non-empty/);
  });

  it('rejects a relative workspace root', () => {
    const config = { ...goodConfig(scratch()), workspaces: [{ id: 'w', root: 'relative/path' }] };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /absolute/);
  });

  it('rejects a workspace root that does not exist', () => {
    const config = goodConfig(scratch());
    const found = validateNodeConfig(config, { exists: () => false });
    assert.ok(found.some((f) => f.level === BLOCK && /workspace root does not exist/.test(f.title)));
  });

  it('rejects an out-of-range port', () => {
    for (const port of [0, 70_000, 8787.5, '8787']) {
      const config = { ...goodConfig(scratch()), port };
      assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /`port`/);
    }
  });

  it('rejects an adapter configured with a .cmd shim, naming the adapter rule', () => {
    const config = { ...goodConfig(scratch()), adapters: { codex: { executable: 'C:\\npm\\codex.cmd' } } };
    const blocker = blockers(validateNodeConfig(config, { exists }))[0];
    assert.match(blocker.title, /shim/);
    assert.match(blocker.fix, /refuses these at init/);
  });

  it('rejects a coordinator_entry that does not exist', () => {
    const config = { ...goodConfig(scratch()), coordinator_entry: 'C:\\missing\\main.js' };
    const found = validateNodeConfig(config, { exists: (p) => !String(p).includes('missing') });
    assert.match(blockers(found)[0].title, /coordinator_entry/);
  });

  it('rejects a non-object document', () => {
    for (const value of [null, [], 'string', 7]) {
      assert.equal(validateNodeConfig(value)[0].level, BLOCK);
    }
  });

  it('tolerates a UTF-8 BOM, as Node Core does', () => {
    assert.deepEqual(parseConfigText('\ufeff{"a":1}'), { a: 1 });
  });
});

describe('node configuration validation — F1 tokens and desktop authorized_apps (RR-07)', () => {
  const exists = () => true;

  it('rejects a token with non-printable ASCII (whitespace cannot survive the wire)', () => {
    const config = { ...goodConfig(scratch()), token: 'A'.repeat(31) + ' ' };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /printable ASCII/);
  });

  it('rejects a token with a tab or a line break', () => {
    for (const suffix of ['\t', '\n', '\r']) {
      const config = { ...goodConfig(scratch()), token: 'A'.repeat(32) + suffix };
      assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /printable ASCII/);
    }
  });

  it('rejects an operator_token with non-printable ASCII', () => {
    const config = { ...goodConfig(scratch()), operator_token: 'B'.repeat(32) + ' ' };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /`operator_token` must contain only printable ASCII/);
  });

  it('accepts valid desktop.authorized_apps rule shapes', () => {
    const config = {
      ...goodConfig(scratch()),
      adapters: {
        desktop: {
          authorized_apps: [
            { image_sha256: 'a'.repeat(64) },
            { signer: 'Microsoft Corporation', product_name: 'Notepad', original_filename: 'NOTEPAD.EXE' },
            { image_path: 'C:\\Windows\\System32\\notepad.exe' },
          ],
        },
      },
    };
    assert.deepEqual(blockers(validateNodeConfig(config, { exists })), []);
  });

  it('rejects a bare-string authorized_apps rule (the old basename form)', () => {
    const config = { ...goodConfig(scratch()), adapters: { desktop: { authorized_apps: ['notepad.exe'] } } };
    const blocker = blockers(validateNodeConfig(config, { exists }))[0];
    assert.match(blocker.title, /bare string/);
    assert.match(blocker.fix, /image_sha256/);
  });

  it('rejects an authorized_apps rule with an unknown property', () => {
    const config = { ...goodConfig(scratch()), adapters: { desktop: { authorized_apps: [{ image_sha256: 'a'.repeat(64), wat: 1 }] } } };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /unknown property/);
  });

  it('rejects a signer rule missing original_filename (amendment A9)', () => {
    const config = {
      ...goodConfig(scratch()),
      adapters: { desktop: { authorized_apps: [{ signer: 'Microsoft Corporation', product_name: 'Notepad' }] } },
    };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /appear together/);
  });

  it('rejects a signer rule whose original_filename carries a path separator (amendment A9)', () => {
    const config = {
      ...goodConfig(scratch()),
      adapters: { desktop: { authorized_apps: [{ signer: 'Microsoft Corporation', product_name: 'Notepad', original_filename: 'dir\\notepad.exe' }] } },
    };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /no path separators/);
  });

  it('rejects a non-64-hex image_sha256 rule', () => {
    const config = { ...goodConfig(scratch()), adapters: { desktop: { authorized_apps: [{ image_sha256: 'zzz' }] } } };
    assert.match(blockers(validateNodeConfig(config, { exists }))[0].title, /64 lower-case hex/);
  });
});

describe('credential handling (criterion 3)', () => {
  it('throws rather than printing a credential value', () => {
    const secret = 'd'.repeat(64);
    assert.throws(() => scrubOrThrow(`token is ${secret}`, [secret]), /refusing to print/);
  });

  it('leaves output that contains no credential alone', () => {
    const text = 'token present, 64 characters';
    assert.equal(scrubOrThrow(text, ['e'.repeat(64)]), text);
  });

  it('ignores values too short to be a credential, so a common word cannot poison the scrub', () => {
    assert.equal(scrubOrThrow('ok', ['ok']), 'ok');
  });

  it('never emits a token value in the report or in --json', () => {
    const root = scratch();
    const localAppData = join(root, 'local');
    const torosDir = join(localAppData, 'Toros');
    mkdirSync(torosDir, { recursive: true });
    const token = 'f0f0'.repeat(16);
    const operatorToken = 'a1a1'.repeat(16);
    const apiKey = 'sk-test-9c9c9c9c9c9c9c9c9c9c9c9c';
    writeFileSync(join(torosDir, 'config.json'), JSON.stringify({
      ...goodConfig(root), token, operator_token: operatorToken,
    }));
    writeFileSync(join(torosDir, 'coordinator.json'), JSON.stringify({
      port: 8787, token, model: 'test-model', base_url: 'https://example.invalid/v1', api_key: apiKey,
    }));

    for (const args of [[], ['--json']]) {
      const output = execFileSync(process.execPath, [ORIENT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, LOCALAPPDATA: localAppData },
      });
      for (const secret of [token, operatorToken, apiKey]) {
        assert.ok(!output.includes(secret), `credential leaked with args ${JSON.stringify(args)}`);
      }
      // ...while still reporting that they are there.
      assert.match(output, /api_key/);
    }
  });
});

describe('executed argument vectors (criterion 5)', () => {
  it('runs only a fixed --version vector', () => {
    const calls = [];
    const run = (file, args) => { calls.push({ file, args }); return { status: 0, stdout: '1.0.0' }; };
    readVersion('C:\\tools\\codex.exe', { run });
    assert.deepEqual(calls, [{ file: 'C:\\tools\\codex.exe', args: ['--version'] }]);
  });

  it('never runs through a shell', () => {
    let options;
    readVersion('x.exe', { run: (_f, _a, o) => { options = o; return { status: 0, stdout: '' }; } });
    assert.equal(options.shell, false);
    assert.ok(options.timeout > 0, 'a version probe must be able to give up');
  });

  it('treats a non-zero exit as no version rather than as output', () => {
    assert.equal(readVersion('x.exe', { run: () => ({ status: 1, stdout: 'nope' }) }), null);
    assert.equal(readVersion('x.exe', { run: () => ({ error: new Error('ENOENT') }) }), null);
  });

  it('bounds a version string that will not stop', () => {
    const version = readVersion('x.exe', { run: () => ({ status: 0, stdout: 'v'.repeat(10_000) }) });
    assert.ok(version.length <= 120);
  });

  it('names every probed binary as a literal, with no interpolation', () => {
    const source = readFileSync(ORIENT, 'utf8');
    for (const family of AGENT_FAMILIES) {
      assert.match(source, new RegExp(`bin: '${family.bin}'`),
        'agent binaries must appear in the source as literals');
    }
  });

  it('resolves PATH entries without executing them', () => {
    const root = scratch();
    writeFileSync(join(root, 'thing.exe'), 'MZ');
    const hits = resolveOnPath('thing', { env: { PATH: root, PATHEXT: '.EXE' }, platform: 'win32' });
    assert.deepEqual(hits, [join(root, 'thing.exe')]);
  });
});

describe('command line', () => {
  it('parses each flag', () => {
    assert.deepEqual(parseArgs(['--json', '--check', '--probe-models', '--verify-agents']), {
      json: true, check: true, probeModels: true, verifyAgents: true,
      initConfig: false, initConfigPath: undefined,
    });
  });

  it('takes an optional path after --init-config without swallowing the next flag', () => {
    assert.equal(parseArgs(['--init-config', '--json']).initConfigPath, undefined);
    assert.equal(parseArgs(['--init-config', '--json']).json, true);
    assert.equal(parseArgs(['--init-config', 'C:\\x\\config.json']).initConfigPath, 'C:\\x\\config.json');
  });

  it('reports an unknown argument rather than ignoring it', () => {
    assert.equal(parseArgs(['--wat']).unknown, '--wat');
  });
});

describe('end to end (criteria 1, 2, 6, 8, 9, 10)', () => {
  const run = (args, env = {}) => {
    try {
      return {
        status: 0,
        output: execFileSync(process.execPath, [ORIENT, ...args], {
          encoding: 'utf8', env: { ...process.env, ...env },
        }),
      };
    } catch (error) {
      return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  };

  it('completes and reports rather than failing when nothing is configured', () => {
    const result = run([], { LOCALAPPDATA: scratch() });
    assert.equal(result.status, 0);
    assert.match(result.output, /no node configuration/);
  });

  it('emits parseable JSON carrying the same findings', () => {
    const result = run(['--json'], { LOCALAPPDATA: scratch() });
    const payload = JSON.parse(result.output);
    assert.ok(Array.isArray(payload.findings) && payload.findings.length > 0);
    assert.ok(payload.summary.blockers >= 0);
    for (const item of payload.findings) {
      assert.ok([OK, WARN, BLOCK].includes(item.level), `unexpected level ${item.level}`);
    }
  });

  it('lists every workspace package in the tree', () => {
    const payload = JSON.parse(run(['--json'], { LOCALAPPDATA: scratch() }).output);
    for (const expected of ['@toros/contracts', '@toros/node-core', '@toros/policy', '@toros/store']) {
      assert.ok(payload.packages.some((p) => p.name === expected), `missing ${expected}`);
    }
  });

  it('makes no outbound request without --probe-models', () => {
    // No network is available to assert against, so assert the structural fact:
    // fetch appears exactly once, inside the function --probe-models gates.
    const source = readFileSync(ORIENT, 'utf8');
    const occurrences = source.split(/\bawait fetch\(/).length - 1;
    assert.equal(occurrences, 1, 'fetch must have exactly one call site');
    assert.match(source, /options\.probeModels \? await probeModels/);
  });

  it('--check exits non-zero when a blocker exists', () => {
    const root = scratch();
    const torosDir = join(root, 'Toros');
    mkdirSync(torosDir, { recursive: true });
    writeFileSync(join(torosDir, 'config.json'), JSON.stringify({ ...goodConfig(root), token: 'tooshort' }));
    const result = run(['--check'], { LOCALAPPDATA: root });
    assert.equal(result.status, 1);
    assert.match(result.output, /BLOCK/);
  });

  it('--check exits zero when nothing blocks', () => {
    assert.equal(run(['--check'], { LOCALAPPDATA: scratch() }).status, 0);
  });

  it('--init-config writes two different tokens and then refuses to overwrite', () => {
    const root = scratch();
    const target = join(root, 'Toros', 'config.json');

    const first = run(['--init-config', target]);
    assert.equal(first.status, 0);
    assert.match(first.output, /starter configuration written/);

    const written = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(written.token.length, 64);
    assert.equal(written.operator_token.length, 64);
    assert.notEqual(written.token, written.operator_token);
    assert.deepEqual(validateNodeConfig(written).filter((f) => f.level === BLOCK), [],
      'a freshly written configuration must be one Node Core accepts');

    const second = run(['--init-config', target]);
    assert.match(second.output, /refusing to overwrite/);
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).token, written.token,
      'the existing credentials must survive a second run');
  });
});

describe('capability inventory', () => {
  it('reads every adapter manifest from the build, or says it needs one', () => {
    const payload = JSON.parse(execFileSync(process.execPath, [ORIENT, '--json'], {
      encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: scratch() },
    }));
    const built = payload.findings.every((f) => !/capability inventory needs a build/.test(f.title));
    if (!built) return; // an unbuilt tree is a legitimate state; criterion 1 covers it.

    const ids = payload.capabilities.map((adapter) => adapter.id).sort();
    assert.deepEqual(ids, ['chrome', 'claude', 'codex', 'excel'],
      'a factory that stops producing a manifest must not vanish silently');
    for (const adapter of payload.capabilities) {
      assert.ok(adapter.actions.length > 0, `${adapter.id} declared no actions`);
      assert.ok(Array.isArray(adapter.platforms) && adapter.platforms.length > 0);
    }
  });

  it('never calls init() while reading manifests — only while verifying', () => {
    // The inventory constructs adapters purely to read `.manifest`, and must
    // stay inert. `--verify-agents` legitimately calls `init()`, so the
    // invariant is not "this file never calls init" but "only verification
    // does" — asserting the broader thing would have to be relaxed the first
    // time anything real needed it, which is how an invariant quietly dies.
    const source = readFileSync(ORIENT, 'utf8');
    const start = source.indexOf('async function verifyAgents');
    const end = source.indexOf('async function collectRealBinarySuites');
    assert.ok(start > 0 && end > start, 'could not locate the verification function');

    for (const match of source.matchAll(/\.init\(\)/g)) {
      assert.ok(match.index > start && match.index < end,
        `init() called outside verifyAgents at index ${match.index}`);
    }
  });
});

describe('agent verification (criteria 11–15)', () => {
  const source = readFileSync(ORIENT, 'utf8');
  const family = { id: 'claude', role: 'CLI agent' };

  it('reports a completed exchange that answered', () => {
    const f = classifyExchange(family, { state: 'succeeded', text: 'TOROSOK', exchangeError: null, seconds: '3' });
    assert.equal(f.level, OK);
    assert.match(f.title, /completed an exchange/);
  });

  it('separates "started but never returned" from every other failure', () => {
    // The distinction is the point of the flag: this one is NOT a config
    // problem, and saying "it does not work" would send the reader to the
    // wrong file.
    const timedOut = classifyExchange(family, { state: 'running', text: '', exchangeError: 'E_TIMEOUT', seconds: '90' });
    assert.equal(timedOut.level, BLOCK);
    assert.match(timedOut.title, /the turn never returns/);
    assert.match(timedOut.fix, /not a Toros configuration/);

    const failed = classifyExchange(family, { state: 'failed', text: '', exchangeError: 'E_ADAPTER_FAILURE', seconds: '2' });
    assert.equal(failed.level, BLOCK);
    assert.match(failed.title, /exchange failed/);
    assert.equal(failed.detail, 'E_ADAPTER_FAILURE');
    assert.notEqual(timedOut.title, failed.title, 'the two failures must not read alike');
  });

  it('treats a state of running with no error as a turn that never returned', () => {
    const f = classifyExchange(family, { state: 'running', text: '', exchangeError: null, seconds: '90' });
    assert.match(f.title, /the turn never returns/);
  });

  it('flags a completed exchange whose reply is wrong, without calling it a failure', () => {
    const f = classifyExchange(family, { state: 'succeeded', text: 'sure thing', exchangeError: null, seconds: '4' });
    assert.equal(f.level, WARN);
  });

  it('asks a fixed literal prompt that no input can reach', () => {
    assert.match(source, /^const VERIFY_PROMPT = '[^'$]+';$/m,
      'the prompt must be a plain literal with no interpolation');
    assert.equal((source.match(/VERIFY_PROMPT\s*=/g) ?? []).length, 1, 'the prompt is assigned once');
  });

  it('starts no agent unless --verify-agents is passed', () => {
    assert.match(source, /options\.verifyAgents \? await verifyAgents/,
      'verification must be gated on the flag');
    assert.equal((source.match(/await verifyAgents\(/g) ?? []).length, 1,
      'verifyAgents must have exactly one call site');
  });

  it('pins a read-only sandbox and a throwaway workspace, and cleans up on every path', () => {
    assert.match(source, /sandbox: 'read-only'/);
    assert.match(source, /mkdtempSync\(join\(tmpdir\(\)/);
    assert.match(source, /finally \{[\s\S]*adapter\.dispose\(\)[\s\S]*rmSync\(root/,
      'the adapter and the temporary workspace must be released in a finally');
  });

  it('reads the suites own paths and preflight rather than restating them', () => {
    assert.match(source, /real-binary-paths\.js/);
    assert.match(source, /real-test-preflight\.js/);
    assert.ok(!/WinGet/.test(source), 'orient must not carry its own copy of a binary path');
  });
});
