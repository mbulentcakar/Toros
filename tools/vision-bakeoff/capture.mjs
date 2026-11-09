/**
 * Node wrapper for capture.ps1 — Toros slice AU0a.
 *
 * Writes parameters to a temporary JSON file, invokes capture.ps1 via execFile
 * with shell: false, validates the resulting PNG, UIA tree JSON, and metadata,
 * and stores the fixture under tools/vision-bakeoff/fixtures/<app>/.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURE_PS1_PATH = path.join(THIS_DIR, 'capture.ps1');
export const FIXTURES_DIR = path.join(THIS_DIR, 'fixtures');

/** Known built-in fixture applications. */
export const APP_PRESETS = {
  calculator: {
    app: 'calculator',
    executable: 'C:\\Windows\\System32\\calc.exe',
    process_names: ['CalculatorApp', 'calc', 'win32calc'],
  },
  notepad: {
    app: 'notepad',
    executable: 'C:\\Windows\\System32\\notepad.exe',
    process_names: ['Notepad', 'notepad'],
  },
};

const UTF8_BOM_RE = /^\uFEFF/;

/** Strip a leading UTF-8 BOM before JSON.parse, matching Toros AR/F discipline. */
export function parseJsonNoBom(text) {
  return JSON.parse(UTF8_BOM_RE.test(text) ? text.replace(UTF8_BOM_RE, '') : text);
}

/** Resolve Windows PowerShell 5.1 path from SystemRoot when available. */
export function powershellPath(env = process.env) {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) return 'powershell.exe';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Copy process.env with PSModulePath removed (case-insensitively). */
export function powershellChildEnvironment(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') {
      delete env[key];
    }
  }
  return env;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Validate a PNG buffer and extract its IHDR pixel dimensions and SHA-256. */
export function validatePngBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    throw new Error('Invalid PNG file: buffer too short');
  }
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG file: missing PNG magic signature');
  }
  const ihdrTag = buf.subarray(12, 16).toString('ascii');
  if (ihdrTag !== 'IHDR') {
    throw new Error(`Invalid PNG file: expected IHDR chunk, got ${JSON.stringify(ihdrTag)}`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { width, height, sha256 };
}

/** Validate the parsed tree.json array produced by capture.ps1. */
export function validateTreeData(tree) {
  const elements = Array.isArray(tree) ? tree : (Array.isArray(tree?.elements) ? tree.elements : null);
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error('Invalid tree.json: expected a non-empty array of UIA elements');
  }
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (typeof el !== 'object' || el === null) {
      throw new Error(`Invalid tree.json element at index ${i}: not an object`);
    }
    if (typeof el.control_type !== 'string' || el.control_type.length === 0) {
      throw new Error(`Invalid tree.json element at index ${i}: missing control_type`);
    }
    if (el.automation_id !== null && el.automation_id !== undefined && typeof el.automation_id !== 'string') {
      throw new Error(`Invalid tree.json element at index ${i}: invalid automation_id`);
    }
    if (el.name !== null && el.name !== undefined && typeof el.name !== 'string') {
      throw new Error(`Invalid tree.json element at index ${i}: invalid name`);
    }
    if (typeof el.enabled !== 'boolean') {
      throw new Error(`Invalid tree.json element at index ${i}: enabled must be boolean`);
    }
    if (typeof el.is_offscreen !== 'boolean') {
      throw new Error(`Invalid tree.json element at index ${i}: is_offscreen must be boolean`);
    }
    const br = el.bounding_rect;
    if (
      typeof br !== 'object' ||
      br === null ||
      typeof br.left !== 'number' ||
      typeof br.top !== 'number' ||
      typeof br.right !== 'number' ||
      typeof br.bottom !== 'number'
    ) {
      throw new Error(`Invalid tree.json element at index ${i}: invalid bounding_rect`);
    }
    if (!Array.isArray(el.selector) || el.selector.length === 0) {
      throw new Error(`Invalid tree.json element at index ${i}: selector must be a non-empty array`);
    }
    for (const step of el.selector) {
      if (
        typeof step !== 'object' ||
        step === null ||
        typeof step.control_type !== 'string' ||
        (step.automation_id !== null && typeof step.automation_id !== 'string') ||
        (step.name !== null && typeof step.name !== 'string') ||
        typeof step.index !== 'number'
      ) {
        throw new Error(`Invalid tree.json element at index ${i}: invalid selector step`);
      }
    }
  }
  return elements;
}

/** Validate meta.json produced by capture.ps1. */
export function validateMetaData(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error('Invalid meta.json: expected an object');
  }
  if (typeof meta.dpi !== 'number' || !Number.isFinite(meta.dpi) || meta.dpi <= 0) {
    throw new Error(`Invalid meta.json: invalid dpi ${JSON.stringify(meta.dpi)}`);
  }
  const wr = meta.window_rect;
  if (
    typeof wr !== 'object' ||
    wr === null ||
    typeof wr.left !== 'number' ||
    typeof wr.top !== 'number' ||
    typeof wr.width !== 'number' ||
    typeof wr.height !== 'number' ||
    wr.width <= 0 ||
    wr.height <= 0
  ) {
    throw new Error('Invalid meta.json: invalid window_rect');
  }
  return meta;
}

/**
 * Capture a fixture for one application by running capture.ps1 via execFile.
 */
export async function captureAppFixture({
  app,
  executable,
  processNames,
  fixturesRoot = FIXTURES_DIR,
  timeoutMs = 30_000,
  spawnFn = execFile,
} = {}) {
  const preset = app ? APP_PRESETS[app.toLowerCase()] : undefined;
  const appId = (app ?? preset?.app ?? '').toLowerCase();
  if (!appId || !/^[a-z0-9_-]+$/.test(appId)) {
    throw new Error(`Invalid or missing app identifier: ${JSON.stringify(app)}`);
  }
  const resolvedExecutable = executable ?? preset?.executable;
  if (!resolvedExecutable || typeof resolvedExecutable !== 'string') {
    throw new Error(`No executable configured for app "${appId}". Provide --executable <path>.`);
  }
  const resolvedProcessNames = processNames ?? preset?.process_names ?? [
    path.basename(resolvedExecutable, path.extname(resolvedExecutable)),
  ];

  const outDir = path.join(fixturesRoot, appId);
  await fs.mkdir(outDir, { recursive: true });

  const imagePath = path.join(outDir, 'window.png');
  const treePath = path.join(outDir, 'tree.json');
  const metaPath = path.join(outDir, 'meta.json');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toros-au0-capture-'));
  const paramsPath = path.join(tmpDir, 'params.json');

  const paramsPayload = {
    app: appId,
    executable: resolvedExecutable,
    process_names: resolvedProcessNames,
    image_path: imagePath,
    tree_path: treePath,
    meta_path: metaPath,
    timeout_ms: Math.min(timeoutMs, 25_000),
  };

  try {
    await fs.writeFile(paramsPath, JSON.stringify(paramsPayload, null, 2), 'utf8');

    await new Promise((resolve, reject) => {
      spawnFn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_PS1_PATH, '-ParamsFile', paramsPath],
        {
          shell: false,
          windowsHide: false,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: powershellChildEnvironment(),
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = [stderr, stdout].filter(Boolean).join(' ').slice(0, 500);
            reject(new Error(`capture.ps1 failed for "${appId}": ${err.message}${detail ? ` (${detail})` : ''}`));
            return;
          }
          resolve();
        },
      );
    });

    const [pngBuf, rawTreeText, rawMetaText] = await Promise.all([
      fs.readFile(imagePath),
      fs.readFile(treePath, 'utf8'),
      fs.readFile(metaPath, 'utf8'),
    ]);

    const pngInfo = validatePngBuffer(pngBuf);
    const treeData = validateTreeData(parseJsonNoBom(rawTreeText));
    const metaData = validateMetaData(parseJsonNoBom(rawMetaText));

    const enrichedMeta = {
      app: appId,
      ...metaData,
      image_size: {
        width: pngInfo.width,
        height: pngInfo.height,
      },
      image_sha256: pngInfo.sha256,
      element_count: treeData.length,
    };

    // Re-write normalized, pretty-printed JSON without BOM
    await Promise.all([
      fs.writeFile(treePath, `${JSON.stringify(treeData, null, 2)}\n`, 'utf8'),
      fs.writeFile(metaPath, `${JSON.stringify(enrichedMeta, null, 2)}\n`, 'utf8'),
    ]);

    return {
      app: appId,
      outDir,
      imagePath,
      treePath,
      metaPath,
      meta: enrichedMeta,
      elementCount: treeData.length,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function parseCaptureArgs(argv) {
  const opts = {
    apps: [],
    executable: undefined,
    processNames: undefined,
    outDir: FIXTURES_DIR,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app' || arg === '--apps') {
      const val = argv[++i] ?? '';
      for (const item of val.split(',').map((s) => s.trim()).filter(Boolean)) {
        opts.apps.push(item);
      }
    } else if (arg.startsWith('--app=')) {
      opts.apps.push(...arg.slice('--app='.length).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--executable') {
      opts.executable = argv[++i];
    } else if (arg === '--process-names') {
      opts.processNames = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--out') {
      opts.outDir = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

const USAGE = `Usage: node tools/vision-bakeoff/capture.mjs --app <notepad|calculator|name> [--executable <path>]`;

export async function main(argv = process.argv.slice(2)) {
  const opts = parseCaptureArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const apps = opts.apps.length > 0 ? opts.apps : ['notepad', 'calculator'];
  for (const app of apps) {
    const result = await captureAppFixture({
      app,
      executable: opts.executable,
      processNames: opts.processNames,
      fixturesRoot: opts.outDir,
    });
    console.log(
      `Captured ${result.app}: ${result.meta.image_size.width}x${result.meta.image_size.height} px @ ${result.meta.dpi} DPI, ${result.elementCount} UIA elements -> ${result.outDir}`,
    );
  }
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
