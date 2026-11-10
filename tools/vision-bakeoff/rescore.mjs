/**
 * Offline re-scorer for vision grounding bakeoff results — Toros slice AU0a.
 *
 * Usage:
 *   node tools/vision-bakeoff/rescore.mjs --in tools/vision-bakeoff/results/<stamp>
 *
 * Re-parses each call record's stored `raw_reply` with the current parser for its
 * grounder, re-scores it against the current fixture (`tree.json`, `meta.json`)
 * and `targets/<app>.json`, rewrites `parsed_point`, `screen_point`,
 * `classification`, `hit_element` (preserving the original `classification` once
 * as `classification_v1` for audit), and regenerates `report.md` and `summary.json`.
 * Requires no network access and no API key.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIXTURES_DIR,
  parseJsonNoBom,
  validateMetaData,
  validateTreeData,
} from './capture.mjs';
import {
  DEFAULT_CONFIG_PATH,
  buildGrounderTable,
  loadGroundersConfig,
} from './grounders.mjs';
import { writeReport } from './report.mjs';
import { TARGETS_DIR } from './run.mjs';
import { scoreResponse } from './score.mjs';

/** Parse CLI arguments for rescore.mjs. */
export function parseRescoreArgs(argv) {
  const opts = {
    inDir: null,
    fixturesDir: FIXTURES_DIR,
    targetsDir: TARGETS_DIR,
    configPath: DEFAULT_CONFIG_PATH,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --in');
      opts.inDir = path.resolve(val);
    } else if (arg.startsWith('--in=')) {
      const val = arg.slice('--in='.length);
      if (!val) throw new Error('Missing value for --in');
      opts.inDir = path.resolve(val);
    } else if (arg === '--fixtures') {
      opts.fixturesDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--fixtures=')) {
      opts.fixturesDir = path.resolve(arg.slice('--fixtures='.length));
    } else if (arg === '--targets') {
      opts.targetsDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--targets=')) {
      opts.targetsDir = path.resolve(arg.slice('--targets='.length));
    } else if (arg === '--config') {
      opts.configPath = path.resolve(argv[++i]);
    } else if (arg.startsWith('--config=')) {
      opts.configPath = path.resolve(arg.slice('--config='.length));
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.help && !opts.inDir) {
    throw new Error('Required argument --in <results dir> is missing');
  }

  return opts;
}

async function loadAppScoringBundle(app, fixturesDir, targetsDir) {
  const appDir = path.join(fixturesDir, app);
  const treePath = path.join(appDir, 'tree.json');
  const metaPath = path.join(appDir, 'meta.json');
  const targetPath = path.join(targetsDir, `${app}.json`);

  const [rawTree, rawMeta, rawTargets] = await Promise.all([
    fs.readFile(treePath, 'utf8'),
    fs.readFile(metaPath, 'utf8'),
    fs.readFile(targetPath, 'utf8'),
  ]);

  const tree = validateTreeData(parseJsonNoBom(rawTree));
  const meta = validateMetaData(parseJsonNoBom(rawMeta));
  if (!meta.image_size) {
    meta.image_size = {
      width: meta.window_rect.width,
      height: meta.window_rect.height,
    };
  }

  const parsedTargets = parseJsonNoBom(rawTargets);
  const targetList = Array.isArray(parsedTargets)
    ? parsedTargets
    : (Array.isArray(parsedTargets?.targets) ? parsedTargets.targets : []);
  const targetsById = new Map();
  for (const t of targetList) {
    if (t && typeof t.id === 'string') {
      targetsById.set(t.id, t);
    }
  }

  return {
    app,
    tree,
    meta,
    imageSize: meta.image_size,
    targetsById,
  };
}

/**
 * Re-parse and re-score all call records in `<inDir>/calls/*.json` offline,
 * rewrite each record (preserving `classification_v1` once for audit), and
 * regenerate `<inDir>/report.md` and `<inDir>/summary.json`.
 */
export async function rescoreBakeoffDir({
  inDir,
  fixturesDir = FIXTURES_DIR,
  targetsDir = TARGETS_DIR,
  configPath = DEFAULT_CONFIG_PATH,
} = {}) {
  if (!inDir) {
    throw new Error('rescoreBakeoffDir requires inDir');
  }

  const config = loadGroundersConfig(configPath);
  const grounderTable = buildGrounderTable(config);

  const callsDir = path.join(inDir, 'calls');
  const entries = await fs.readdir(callsDir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  if (jsonFiles.length === 0) {
    throw new Error(`No call records found in ${callsDir}`);
  }

  const rawRecords = [];
  const appsNeeded = new Set();

  for (const fileName of jsonFiles) {
    const filePath = path.join(callsDir, fileName);
    const rawText = await fs.readFile(filePath, 'utf8');
    const rec = parseJsonNoBom(rawText);
    if (rec && typeof rec === 'object' && typeof rec.app === 'string') {
      appsNeeded.add(rec.app);
      rawRecords.push({ filePath, rec });
    }
  }

  const appBundles = new Map();
  for (const app of appsNeeded) {
    const bundle = await loadAppScoringBundle(app, fixturesDir, targetsDir);
    appBundles.set(app, bundle);
  }

  const updatedRecords = [];

  for (const { filePath, rec } of rawRecords) {
    const appBundle = appBundles.get(rec.app);
    const grounder = grounderTable[rec.grounder];
    const target = appBundle?.targetsById.get(rec.target_id);
    const expected = target?.expected ?? [];

    const classificationV1 = rec.classification_v1 !== undefined
      ? rec.classification_v1
      : rec.classification;

    const isTransportError =
      rec.classification === 'transport_error' ||
      rec.classification_v1 === 'transport_error' ||
      (Boolean(rec.error) && (typeof rec.raw_reply !== 'string' || rec.raw_reply.trim().length === 0));

    let parsed;
    if (isTransportError) {
      parsed = {
        ok: false,
        status: 'transport_error',
        error: rec.error ?? 'Transport error recorded during run',
      };
    } else if (!grounder || typeof grounder.parser !== 'function') {
      parsed = {
        ok: false,
        status: 'parse_error',
        error: `Unknown grounder "${rec.grounder}"`,
      };
    } else {
      parsed = grounder.parser(rec.raw_reply ?? '', appBundle.imageSize);
    }

    const scored = scoreResponse({
      parsed,
      tree: appBundle.tree,
      expected,
      meta: appBundle.meta,
    });

    const updated = {
      grounder: rec.grounder,
      model: rec.model,
      app: rec.app,
      target_id: rec.target_id,
      description: target?.description ?? rec.description,
      hard: target !== undefined ? Boolean(target.hard) : Boolean(rec.hard),
      repeat: rec.repeat ?? 1,
      raw_reply: rec.raw_reply ?? '',
      parsed_point: parsed?.point ?? null,
      screen_point: scored.screen_point,
      classification: scored.classification,
      classification_v1: classificationV1,
      hit_element: scored.element,
      latency_ms: rec.latency_ms ?? null,
      usage: rec.usage ?? null,
      ...(rec.error ? { error: rec.error } : {}),
      timestamp: rec.timestamp ?? new Date().toISOString(),
    };

    await fs.writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    updatedRecords.push(updated);
  }

  const reportInfo = await writeReport(inDir, updatedRecords);

  return {
    inDir,
    totalRecords: updatedRecords.length,
    rescoredCount: updatedRecords.length,
    records: updatedRecords,
    ...reportInfo,
  };
}

const USAGE = [
  'Usage: node tools/vision-bakeoff/rescore.mjs --in <results dir> [options]',
  '  --in <dir>         Results directory containing calls/*.json (required)',
  '  --fixtures <dir>   Fixtures root directory (default: tools/vision-bakeoff/fixtures)',
  '  --targets <dir>    Targets directory (default: tools/vision-bakeoff/targets)',
  '  --config <path>    Grounders config path (default: tools/vision-bakeoff/grounders.config.json)',
].join('\n');

export async function main(argv = process.argv.slice(2)) {
  const opts = parseRescoreArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const result = await rescoreBakeoffDir({
    inDir: opts.inDir,
    fixturesDir: opts.fixturesDir,
    targetsDir: opts.targetsDir,
    configPath: opts.configPath,
  });

  console.log(`Re-scored ${result.totalRecords} records -> ${result.reportPath}`);
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
