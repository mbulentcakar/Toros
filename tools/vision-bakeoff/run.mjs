/**
 * Vision grounding bakeoff runner CLI — Toros slice AU0a.
 *
 * Usage:
 *   node tools/vision-bakeoff/run.mjs \
 *     --apps notepad,calculator \
 *     --grounders ui-tars-1.5-7b,claude,qwen \
 *     --repeat 1 \
 *     --out tools/vision-bakeoff/results/<stamp>
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIXTURES_DIR,
  captureAppFixture,
  parseJsonNoBom,
  validateMetaData,
  validatePngBuffer,
  validateTreeData,
} from './capture.mjs';
import {
  DEFAULT_CONFIG_PATH,
  assertApiKeysPresent,
  buildGrounderTable,
  callGrounder,
  checkOpenRouterModels,
  isLocalGrounderReachable,
  loadGroundersConfig,
  scrubSecrets,
} from './grounders.mjs';
import { writeReport } from './report.mjs';
import { scoreResponse } from './score.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TARGETS_DIR = path.join(THIS_DIR, 'targets');
export const RESULTS_ROOT = path.join(THIS_DIR, 'results');
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_DEADLINE_MS = 60_000;

function defaultTimestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Parse CLI arguments for run.mjs. */
export function parseRunArgs(argv) {
  const opts = {
    apps: ['notepad', 'calculator'],
    grounders: ['ui-tars-1.5-7b', 'claude', 'qwen'],
    repeat: 1,
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    deadlineMs: DEFAULT_DEADLINE_MS,
    outDir: null,
    fixturesDir: FIXTURES_DIR,
    targetsDir: TARGETS_DIR,
    configPath: DEFAULT_CONFIG_PATH,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apps' || arg === '--app') {
      const val = argv[++i] ?? '';
      opts.apps = val.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg.startsWith('--apps=')) {
      opts.apps = arg.slice('--apps='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg === '--grounders' || arg === '--grounder') {
      const val = argv[++i] ?? '';
      opts.grounders = val.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--grounders=')) {
      opts.grounders = arg.slice('--grounders='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--repeat') {
      opts.repeat = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith('--repeat=')) {
      opts.repeat = Number.parseInt(arg.slice('--repeat='.length), 10);
    } else if (arg === '--limit') {
      opts.limit = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith('--limit=')) {
      opts.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    } else if (arg === '--out') {
      opts.outDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--out=')) {
      opts.outDir = path.resolve(arg.slice('--out='.length));
    } else if (arg === '--fixtures') {
      opts.fixturesDir = path.resolve(argv[++i]);
    } else if (arg === '--targets') {
      opts.targetsDir = path.resolve(argv[++i]);
    } else if (arg === '--config') {
      opts.configPath = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) {
    throw new Error(`Invalid --repeat value: ${opts.repeat}`);
  }
  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error(`Invalid --limit value: ${opts.limit}`);
  }
  if (opts.apps.length === 0) {
    throw new Error('At least one app must be specified via --apps');
  }
  if (opts.grounders.length === 0) {
    throw new Error('At least one grounder must be specified via --grounders');
  }

  return opts;
}

function makeCallKey(grounderId, app, targetId, repeatIndex) {
  return `${grounderId}__${app}__${targetId}__r${repeatIndex}`;
}

async function loadExistingRecords(outDir) {
  const recordsByKey = new Map();
  const callsDir = path.join(outDir, 'calls');
  try {
    const entries = await fs.readdir(callsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(callsDir, entry.name);
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const rec = parseJsonNoBom(raw);
        if (rec && rec.grounder && rec.app && rec.target_id) {
          const key = makeCallKey(rec.grounder, rec.app, rec.target_id, rec.repeat ?? 1);
          recordsByKey.set(key, rec);
        }
      } catch {
        // Ignore partially written file if interrupted mid-write
      }
    }
  } catch {
    // callsDir does not exist yet
  }
  return recordsByKey;
}

async function loadTargetsForApp(app, targetsDir = TARGETS_DIR, limit = null) {
  const targetPath = path.join(targetsDir, `${app}.json`);
  const raw = await fs.readFile(targetPath, 'utf8');
  const parsed = parseJsonNoBom(raw);
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.targets) ? parsed.targets : null);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`Target file ${targetPath} must contain a non-empty array of targets`);
  }
  return typeof limit === 'number' && limit > 0 ? list.slice(0, limit) : list;
}

async function loadOrCaptureFixture(app, fixturesDir = FIXTURES_DIR, captureFn = captureAppFixture) {
  const appDir = path.join(fixturesDir, app);
  const imagePath = path.join(appDir, 'window.png');
  const treePath = path.join(appDir, 'tree.json');
  const metaPath = path.join(appDir, 'meta.json');

  let exists = true;
  try {
    await Promise.all([
      fs.access(imagePath),
      fs.access(treePath),
      fs.access(metaPath),
    ]);
  } catch {
    exists = false;
  }

  if (!exists) {
    await captureFn({ app, fixturesRoot: fixturesDir });
  }

  const [pngBuf, rawTree, rawMeta] = await Promise.all([
    fs.readFile(imagePath),
    fs.readFile(treePath, 'utf8'),
    fs.readFile(metaPath, 'utf8'),
  ]);

  const pngInfo = validatePngBuffer(pngBuf);
  const tree = validateTreeData(parseJsonNoBom(rawTree));
  const meta = validateMetaData(parseJsonNoBom(rawMeta));
  if (!meta.image_size) {
    meta.image_size = { width: pngInfo.width, height: pngInfo.height };
  }

  return {
    app,
    imageBase64: pngBuf.toString('base64'),
    imageSize: { width: pngInfo.width, height: pngInfo.height },
    tree,
    meta,
  };
}

/**
 * Execute an array of async task functions with bounded concurrency.
 */
export async function runWithConcurrency(taskFns, concurrency = DEFAULT_CONCURRENCY) {
  const limit = Math.max(1, Math.min(concurrency, taskFns.length || 1));
  const results = new Array(taskFns.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= taskFns.length) return;
      results[idx] = await taskFns[idx]();
    }
  }

  const workers = [];
  for (let w = 0; w < limit; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Execute the vision bakeoff run.
 *
 * Pre-flight checks:
 *   1. Resolve requested grounders from `grounders.config.json`.
 *   2. Fail fast if any required `key_env` is missing from `env`, BEFORE any
 *      window capture or network call.
 *   3. Check all non-local OpenRouter models against `/api/v1/models` and
 *      refuse to run if any configured model ID is absent.
 *   4. Probe optional `local` grounder and skip if unreachable.
 */
export async function runBakeoff({
  apps = ['notepad', 'calculator'],
  grounderIds = ['ui-tars-1.5-7b', 'claude', 'qwen'],
  repeat = 1,
  limit = null,
  concurrency = DEFAULT_CONCURRENCY,
  deadlineMs = DEFAULT_DEADLINE_MS,
  outDir = path.join(RESULTS_ROOT, defaultTimestampSlug()),
  fixturesDir = FIXTURES_DIR,
  targetsDir = TARGETS_DIR,
  configPath = DEFAULT_CONFIG_PATH,
  env = process.env,
  fetchFn = globalThis.fetch,
  captureFn = captureAppFixture,
  logger = console,
} = {}) {
  const config = loadGroundersConfig(configPath);
  const grounderTable = buildGrounderTable(config);

  const selectedGrounders = grounderIds.map((id) => {
    const g = grounderTable[id];
    if (!g) {
      throw new Error(`Unknown grounder "${id}". Known grounders: ${Object.keys(grounderTable).join(', ')}`);
    }
    return g;
  });

  // 1. Fail fast on missing API key BEFORE any capture or network request
  assertApiKeysPresent(selectedGrounders, env);

  // 2. Filter optional local grounder if unreachable, and verify OpenRouter model IDs
  const activeGrounders = [];
  const openRouterGrounders = [];

  for (const g of selectedGrounders) {
    if (g.optional) {
      const reachable = await isLocalGrounderReachable(g, { fetchFn });
      if (!reachable) {
        logger.warn?.(`Skipping optional grounder "${g.id}" (${g.endpoint} is unreachable).`);
        continue;
      }
      activeGrounders.push(g);
    } else {
      activeGrounders.push(g);
      openRouterGrounders.push(g);
    }
  }

  let pricingByModel = new Map();
  if (openRouterGrounders.length > 0) {
    const catalogCheck = await checkOpenRouterModels(openRouterGrounders, {
      fetchFn,
      apiKey: env.OPENROUTER_API_KEY,
    });
    pricingByModel = catalogCheck.pricingByModel;
  }

  // 3. Load targets and fixtures for each requested app
  const appBundles = new Map();
  for (const app of apps) {
    const targets = await loadTargetsForApp(app, targetsDir, limit);
    const fixture = await loadOrCaptureFixture(app, fixturesDir, captureFn);
    appBundles.set(app, { targets, fixture });
  }

  // 4. Prepare output directory and load existing records for resumption
  const callsDir = path.join(outDir, 'calls');
  await fs.mkdir(callsDir, { recursive: true });
  const existingByKey = await loadExistingRecords(outDir);

  const allRecords = [];
  const pendingTasks = [];

  for (const app of apps) {
    const { targets, fixture } = appBundles.get(app);
    for (const grounder of activeGrounders) {
      for (const target of targets) {
        for (let r = 1; r <= repeat; r++) {
          const key = makeCallKey(grounder.id, app, target.id, r);
          if (existingByKey.has(key)) {
            allRecords.push(existingByKey.get(key));
            continue;
          }

          pendingTasks.push(async () => {
            const secretVal = grounder.key_env ? (env[grounder.key_env] ?? '') : '';
            let rawReply = '';
            let parsed = null;
            let latencyMs = null;
            let usage = null;
            let errorText = null;

            try {
              const callRes = await callGrounder({
                grounder,
                imageBase64: fixture.imageBase64,
                imageSize: fixture.imageSize,
                description: target.description,
                env,
                fetchFn,
                deadlineMs,
              });
              rawReply = callRes.raw_reply;
              parsed = callRes.parsed;
              latencyMs = callRes.latency_ms;
              usage = callRes.usage;
            } catch (err) {
              errorText = scrubSecrets(err?.message ?? String(err), [secretVal]);
              latencyMs = typeof err?.latency_ms === 'number' ? err.latency_ms : null;
              parsed = { ok: false, status: 'parse_error', error: errorText };
            }

            const scored = scoreResponse({
              parsed,
              tree: fixture.tree,
              expected: target.expected,
              meta: fixture.meta,
            });

            const record = {
              grounder: grounder.id,
              model: grounder.model,
              app,
              target_id: target.id,
              description: target.description,
              hard: Boolean(target.hard),
              repeat: r,
              raw_reply: rawReply,
              parsed_point: parsed?.point ?? null,
              screen_point: scored.screen_point,
              classification: scored.classification,
              hit_element: scored.element,
              latency_ms: latencyMs,
              usage,
              ...(errorText ? { error: errorText } : {}),
              timestamp: new Date().toISOString(),
            };

            const recordPath = path.join(callsDir, `${key}.json`);
            await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
            return record;
          });
        }
      }
    }
  }

  const freshRecords = await runWithConcurrency(pendingTasks, concurrency);
  allRecords.push(...freshRecords);

  const reportInfo = await writeReport(outDir, allRecords, pricingByModel);

  return {
    outDir,
    totalRecords: allRecords.length,
    resumedRecords: existingByKey.size,
    executedRecords: freshRecords.length,
    ...reportInfo,
  };
}

const USAGE = [
  'Usage: node tools/vision-bakeoff/run.mjs [options]',
  '  --apps <notepad,calculator>                Apps to evaluate (default: notepad,calculator)',
  '  --grounders <ui-tars-1.5-7b,claude,qwen>   Grounders to run (default: ui-tars-1.5-7b,claude,qwen)',
  '  --repeat <N>                               Repetitions per target (default: 1)',
  '  --limit <N>                                Limit targets per app (optional)',
  '  --out <dir>                                Output directory (default: tools/vision-bakeoff/results/<stamp>)',
].join('\n');

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseRunArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const outDir = opts.outDir ?? path.join(RESULTS_ROOT, defaultTimestampSlug());
  const result = await runBakeoff({
    apps: opts.apps,
    grounderIds: opts.grounders,
    repeat: opts.repeat,
    limit: opts.limit,
    concurrency: opts.concurrency,
    deadlineMs: opts.deadlineMs,
    outDir,
    fixturesDir: opts.fixturesDir,
    targetsDir: opts.targetsDir,
    configPath: opts.configPath,
    env,
  });

  console.log(
    `Bakeoff complete (${result.executedRecords} new calls, ${result.resumedRecords} resumed) -> ${result.reportPath}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(err?.message ?? String(err));
      process.exitCode = 1;
    },
  );
}
