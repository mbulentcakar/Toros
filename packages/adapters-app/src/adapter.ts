import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream as fsCreateReadStream, promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ErrorCode,
  TorosError,
  type Adapter,
  type AdapterContext,
  type ActionResult,
  type AdapterManifest,
  type ActionSchema,
  type JsonValue,
} from '@toros/contracts';

import { EXCEL_ACTION_PS1 } from './scripts.js';
import { parseScriptJson } from './json.js';
import {
  assertPdfPath,
  assertRangeShape,
  assertRangeWithinCells,
  assertSheetName,
  assertWorkbookPath,
  validateValues,
  type CellValue,
  type ParsedRange,
} from './validate.js';

/**
 * The pilot desktop adapter's configuration. The executable is verified at
 * `init()` so a host without Excel fails loudly at registration rather than
 * midway through a job.
 */
export interface ExcelAdapterOptions {
  /** Absolute path to EXCEL.EXE, verified at init. */
  readonly executable: string;
  /** Wall-clock ceiling per action, milliseconds. */
  readonly timeout_ms: number;
  /** Maximum cells a single read_range or write_range may address. */
  readonly max_cells: number;
}

const ADAPTER_ID = 'excel';
const ADAPTER_VERSION = '0.1.0';
/** Output is bounded by max_cells; this is a generous backstop for E_OUTPUT_LIMIT. */
const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

const FOUR_ACTIONS: readonly string[] = ['inspect_workbook', 'read_range', 'write_range', 'export_pdf'];

const RANGE_PATTERN = '^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$';
const WORKBOOK_PATTERN = '\\.(xlsx|xlsm)$';
const PDF_PATTERN = '\\.pdf$';

/**
 * JSON Schemas are declarative — the registry would enforce them — but this
 * adapter defends in depth because its tests reach `invoke` directly. The
 * pinned range grammar appears here too so a reader can see the contract in
 * one place.
 */
function buildManifest(options: ExcelAdapterOptions): AdapterManifest {
  const actions: readonly ActionSchema[] = [
    {
      id: 'inspect_workbook',
      path_fields: ['path'],
      summary: 'List sheet names, used range, and cell counts of an .xlsx/.xlsm workbook.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string', pattern: WORKBOOK_PATTERN } },
      },
      mutates: false,
      always_requires_approval: false,
      output_limit_bytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    },
    {
      id: 'read_range',
      path_fields: ['path'],
      summary: 'Read a rectangular A1 range as a 2-D array of string|number|boolean|null.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sheet', 'range'],
        properties: {
          path: { type: 'string', pattern: WORKBOOK_PATTERN },
          sheet: { type: 'string', minLength: 1 },
          range: { type: 'string', pattern: RANGE_PATTERN },
        },
      },
      mutates: false,
      always_requires_approval: false,
      output_limit_bytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    },
    {
      id: 'write_range',
      path_fields: ['path'],
      summary: 'Write a 2-D array into a rectangular A1 range, save, and close.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sheet', 'range', 'values'],
        properties: {
          path: { type: 'string', pattern: WORKBOOK_PATTERN },
          sheet: { type: 'string', minLength: 1 },
          range: { type: 'string', pattern: RANGE_PATTERN },
          values: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'array',
              minItems: 1,
              // A cell genuinely holds one of four JSON scalar types, but
              // `type: [...]` is the union keyword Ajv's strict mode rejects —
              // and the registry sets allowUnionTypes: false deliberately, so
              // a typo'd keyword is a defect the author hears about rather than
              // a constraint silently ignored. `anyOf` expresses the same set
              // without relaxing that. Caught at deploy: the adapter compiled
              // and its tests passed, then failed to REGISTER on a real node.
              items: {
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      },
      mutates: true,
      always_requires_approval: false,
      output_limit_bytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    },
    {
      id: 'export_pdf',
      path_fields: ['path', 'out_path'],
      summary: 'Export a workbook (or one sheet) to a .pdf file at out_path.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'out_path'],
        properties: {
          path: { type: 'string', pattern: WORKBOOK_PATTERN },
          out_path: { type: 'string', pattern: PDF_PATTERN },
          sheet: { type: 'string', minLength: 1 },
        },
      },
      mutates: true,
      always_requires_approval: false,
      output_limit_bytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    },
  ];

  return {
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    platforms: ['win32'],
    actions,
    required_permissions: ['process.spawn', 'fs.read', 'fs.write', 'app.automation'],
    allowed_resources: ['*.xlsx', '*.xlsm', '*.pdf'],
    default_timeout_ms: options.timeout_ms,
    cancellation: 'kill',
    receipt_fields: ['excel_pid'],
  };
}

// ---------------------------------------------------------------------------
// Windows process helpers. No-ops off win32 — integration tests gate on
// win32 + a real EXCEL.EXE, and a schema rejection never reaches these.
// ---------------------------------------------------------------------------

/** Lists EXCEL.EXE pids via `tasklist`. Used to kill the Excel we started on a
 *  timeout without touching an unrelated instance the operator may hold. */
function listExcelPids(): Promise<Set<number>> {
  if (process.platform !== 'win32') return Promise.resolve(new Set<number>());
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq EXCEL.EXE', '/FO', 'CSV', '/NH'],
      { shell: false, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(new Set<number>());
          return;
        }
        const pids = new Set<number>();
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.split(',');
          const nameField = parts[0];
          const pidField = parts[1];
          if (nameField === undefined || pidField === undefined) continue;
          const name = nameField.replaceAll('"', '').toUpperCase();
          if (name !== 'EXCEL.EXE') continue;
          const pid = Number.parseInt(pidField.replaceAll('"', ''), 10);
          if (Number.isFinite(pid)) pids.add(pid);
        }
        resolve(pids);
      },
    );
  });
}

function killPid(pid: number): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/F', '/PID', String(pid)], { shell: false, windowsHide: true }, () => resolve());
  });
}

/**
 * On a timeout we kill the PowerShell child ourselves, then the EXCEL.EXE it
 * started. SPEC F: "do not kill every EXCEL.EXE on the machine". The Excel pid
 * the script reports (a before/after snapshot at creation time) is preferred
 * because it is precisely *ours*; if it was never recorded we fall back to the
 * diff against the pre-action snapshot, which still excludes anything that
 * existed before our action (the test-16 unrelated instance).
 */
async function killOurExcel(beforePids: Set<number>, pidJsonPath: string): Promise<void> {
  let reportedPid: number | null = null;
  try {
    const txt = await fsPromises.readFile(pidJsonPath, 'utf8');
    const obj = parseScriptJson(txt) as { excel_pid?: unknown };
    if (typeof obj.excel_pid === 'number') reportedPid = obj.excel_pid;
  } catch {
    // pid.json absent — Excel never started, or not yet recorded.
  }

  // Kill ONLY the pid the script reported, and only if it is not one that
  // existed before this action.
  //
  // There used to be a fallback: when pid.json was absent, kill every
  // EXCEL.EXE missing from the pre-action snapshot. That is unsafe, and the
  // acceptance test could not catch it — the test starts its unrelated
  // instance BEFORE the snapshot, so that instance is in `beforePids` and is
  // spared. An operator who opens Excel *after* the snapshot, during a long
  // action, is not, and would lose unsaved work to a timeout in an unrelated
  // job.
  //
  // The trade is deliberate. Without a reported pid there is no way to tell
  // our Excel from the operator's, and leaving an orphan is recoverable while
  // killing their workbook is not. An orphan is also unlikely here: pid.json
  // is written early, so its absence means Excel never started.
  if (reportedPid !== null && !beforePids.has(reportedPid)) {
    await killPid(reportedPid);
  }
}

interface ScriptResult {
  readonly payload: Record<string, unknown>;
  readonly excel_pid: number | null;
}

interface SpawnFailure {
  readonly err: unknown;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The absolute path to Windows PowerShell, built from `SystemRoot`.
 *
 * Everything else about this spawn is already right -- a fixed
 * parameter-free script, every input in a JSON file, `shell: false`, nothing
 * interpolated. The bare name was the exception: it resolved through the
 * inherited `PATH`, so anything earlier on that path named `powershell.exe`
 * ran instead, in a process that Node Core spawns and that therefore sits
 * beside the node's own credentials.
 *
 * Exploiting that needs write access to a `PATH` directory, which is close to
 * already owning the account -- but the fix is free, the cockpit's Rust side
 * already builds an absolute `System32\schtasks.exe` for the same reason, and
 * Node Core is the one process here that should never be the weak link.
 *
 * Falls back to the bare name only if `SystemRoot` is unset, which on Windows
 * means the environment is already broken; the spawn then fails as it did
 * before rather than in a new way.
 */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'];
  if (systemRoot === undefined || systemRoot.length === 0) return 'powershell.exe';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The child environment for a Windows PowerShell 5.1 spawn: a copy of
 * `process.env` with `PSModulePath` removed, so 5.1 rebuilds its own default
 * module path instead of inheriting a possibly-polluted one. Windows env names
 * are case-insensitive, so every key whose lower-case form is `psmodulepath` is
 * deleted — never just two hard-coded spellings. The copy is deliberate —
 * `process.env` is never mutated.
 */
export function powershellChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

/** Best-effort message from an `unknown` spawn error, without `instanceof`
 *  (which TS forbids on `unknown` left-hand sides). */
function describeError(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

/**
 * Writes the fixed script and a JSON input file into a fresh temp directory,
 * invokes PowerShell with `shell:false`, and reads the JSON result back. The
 * temp directory is the "session directory" for this one-shot action. A timeout
 * kills the PowerShell child plus the Excel it started.
 */
async function runScript(
  input: Record<string, JsonValue>,
  options: ExcelAdapterOptions,
  ctx: AdapterContext,
): Promise<ScriptResult> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-excel-'));
  const scriptPath = path.join(dir, 'action.ps1');
  const inPath = path.join(dir, 'input.json');
  const outPath = path.join(dir, 'output.json');
  const pidPath = path.join(dir, 'pid.json');

  if (ctx.signal.aborted) {
    throw new TorosError(ErrorCode.E_CANCELLED, 'action aborted before start', {});
  }

  try {
    await fsPromises.writeFile(scriptPath, EXCEL_ACTION_PS1, 'utf8');
    await fsPromises.writeFile(inPath, JSON.stringify(input), 'utf8');

    const beforePids = await listExcelPids();

    const child: ChildProcess = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { shell: false, windowsHide: true, env: powershellChildEnvironment() },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

    let terminateReason: ErrorCode | null = null;
    let settled = false;
    let spawnFailure: SpawnFailure | null = null;

    const timer = setTimeout(() => {
      terminateReason = ErrorCode.E_TIMEOUT;
      try { child.kill(); } catch { /* already gone */ }
      killOurExcel(beforePids, pidPath).catch(() => {});
    }, options.timeout_ms);

    const onAbort = (): void => {
      terminateReason = ErrorCode.E_CANCELLED;
      try { child.kill(); } catch { /* already gone */ }
      killOurExcel(beforePids, pidPath).catch(() => {});
    };
    ctx.signal.addEventListener?.('abort', onAbort, { once: true });

    const code: number = await new Promise<number>((resolve) => {
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        spawnFailure = { err, stdout, stderr };
        resolve(-1);
      });
      child.once('close', (c: number | null) => {
        if (settled) return;
        settled = true;
        resolve(c ?? -1);
      });
    });

    clearTimeout(timer);
    ctx.signal.removeEventListener?.('abort', onAbort);

    // Reap on EVERY path, not just timeout and cancellation.
    //
    // The script quits Excel and releases the COM object in its finally block,
    // and the PowerShell process has exited by the time we get here — but the
    // RCW teardown is asynchronous, and EXCEL.EXE was observed still running
    // more than 20 seconds after a clean, successful action. SPEC §12.1 asks
    // that no EXCEL.EXE survive an action, and "it exits eventually" does not
    // meet that: an operator's next action would find a stale instance holding
    // the workbook.
    //
    // killOurExcel targets the pid the script itself recorded, and falls back
    // to pids absent from the pre-run snapshot. It cannot touch an Excel the
    // operator already had open, which is the property test 16 exists to prove.
    await killOurExcel(beforePids, pidPath).catch(() => {});

    if (spawnFailure !== null) {
      const { err } = spawnFailure;
      throw new TorosError(
        ErrorCode.E_ADAPTER_FAILURE,
        `failed to launch powershell.exe: ${describeError(err)}`,
        { action: input['action'] ?? '' },
      );
    }

    if (terminateReason !== null) {
      throw new TorosError(
        terminateReason,
        terminateReason === ErrorCode.E_TIMEOUT
          ? `excel action timed out after ${options.timeout_ms}ms`
          : 'excel action cancelled',
        { action: input['action'] ?? '' },
      );
    }

    if (code !== 0) {
      throw new TorosError(
        ErrorCode.E_ADAPTER_FAILURE,
        `powershell exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`,
        { action: input['action'] ?? '' },
      );
    }

    let outTxt: string;
    try {
      outTxt = await fsPromises.readFile(outPath, 'utf8');
    } catch {
      throw new TorosError(
        ErrorCode.E_ADAPTER_FAILURE,
        `script produced no output (stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)})`,
        { action: input['action'] ?? '' },
      );
    }

    let parsed: { ok?: unknown; error?: unknown; [k: string]: unknown };
    try {
      parsed = parseScriptJson(outTxt) as { ok?: unknown; error?: unknown; [k: string]: unknown };
    } catch {
      throw new TorosError(
        ErrorCode.E_ADAPTER_FAILURE,
        `script output was not JSON: ${outTxt.slice(0, 500)}`,
        { action: input['action'] ?? '' },
      );
    }

    if (parsed.ok !== true) {
      const msg = typeof parsed.error === 'string' ? parsed.error : 'unknown script error';
      throw new TorosError(ErrorCode.E_ADAPTER_FAILURE, `excel action failed: ${msg}`, {
        action: input['action'] ?? '',
      });
    }

    let excelPid: number | null = null;
    try {
      const pidTxt = await fsPromises.readFile(pidPath, 'utf8');
      const pidObj = parseScriptJson(pidTxt) as { excel_pid?: unknown };
      if (typeof pidObj.excel_pid === 'number') excelPid = pidObj.excel_pid;
    } catch {
      // pid.json is best-effort; the script's Quit() already cleaned up.
    }

    return { payload: parsed, excel_pid: excelPid };
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Computes the sha256 and byte size of a produced artifact file. */
async function artifactFor(filePath: string): Promise<{ readonly path: string; readonly sha256: string; readonly bytes: number }> {
  const stat = await fsPromises.stat(filePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fsCreateReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return { path: filePath, sha256: hash.digest('hex'), bytes: stat.size };
}

/**
 * SPEC F public API. Builds an `Adapter` (not a `SessionAdapter` — Excel
 * actions are one-shot) whose manifest exposes exactly the four pinned actions
 * and nothing else.
 */
export function createExcelAdapter(options: ExcelAdapterOptions): Adapter {
  const manifest = buildManifest(options);

  const adapter: Adapter = {
    manifest,

    async init(): Promise<void> {
      let isFile: boolean;
      try {
        const stat = await fsPromises.stat(options.executable);
        isFile = stat.isFile();
      } catch {
        throw new TorosError(
          ErrorCode.E_ADAPTER_FAILURE,
          `Excel executable not found: ${options.executable}`,
          { executable: options.executable },
        );
      }
      if (!isFile) {
        throw new TorosError(
          ErrorCode.E_ADAPTER_FAILURE,
          `Excel executable path is not a file: ${options.executable}`,
          { executable: options.executable },
        );
      }
    },

    async invoke(actionId: string, args: Readonly<Record<string, JsonValue>>, ctx: AdapterContext): Promise<ActionResult> {
      const action = manifest.actions.find((a) => a.id === actionId);
      if (action === undefined) {
        throw new TorosError(ErrorCode.E_NOT_REGISTERED, `excel has no action "${actionId}"`, { actionId });
      }

      // Validate and assemble the JSON input for the fixed script. Every
      // schema rejection throws E_SCHEMA here, before any process is spawned.
      const input: Record<string, JsonValue> = {};

      switch (actionId) {
        case 'inspect_workbook': {
          const p = args['path'];
          assertWorkbookPath(p);
          input['action'] = 'inspect_workbook';
          input['path'] = p;
          break;
        }
        case 'read_range': {
          const p = args['path'];
          assertWorkbookPath(p);
          const s = args['sheet'];
          assertSheetName(s);
          const r = args['range'];
          assertRangeShape(r);
          assertRangeWithinCells(r, options.max_cells);
          input['action'] = 'read_range';
          input['path'] = p;
          input['sheet'] = s;
          input['range'] = r;
          break;
        }
        case 'write_range': {
          const p = args['path'];
          assertWorkbookPath(p);
          const s = args['sheet'];
          assertSheetName(s);
          const r = args['range'];
          assertRangeShape(r);
          const parsed: ParsedRange = assertRangeWithinCells(r, options.max_cells);
          const v = args['values'];
          const values: CellValue[][] = validateValues(v, parsed, options.max_cells);
          // Flatten the validated 2-D array into a row-major `cells` list plus
          // explicit `rows`/`cols`. The fixed script rebuilds it from those —
          // never from a nested PowerShell array, which ConvertFrom-Json in
          // Windows PowerShell 5.1 may unwrap when it has a single row.
          const cells: CellValue[] = [];
          for (const row of values) {
            for (const cell of row) {
              cells.push(cell);
            }
          }
          input['action'] = 'write_range';
          input['path'] = p;
          input['sheet'] = s;
          input['range'] = r;
          input['cells'] = cells;
          input['rows'] = values.length;
          input['cols'] = values[0]?.length ?? 0;
          break;
        }
        case 'export_pdf': {
          const p = args['path'];
          assertWorkbookPath(p);
          const o = args['out_path'];
          assertPdfPath(o);
          input['action'] = 'export_pdf';
          input['path'] = p;
          input['out_path'] = o;
          const s = args['sheet'];
          if (typeof s === 'string' && s.length > 0) {
            input['sheet'] = s;
          }
          break;
        }
        default: {
          // Unreachable: the find() above guards the four known actions.
          throw new TorosError(ErrorCode.E_NOT_REGISTERED, `excel has no action "${actionId}"`, { actionId });
        }
      }

      const { payload, excel_pid } = await runScript(input, options, ctx);

      let outputBody: Record<string, unknown>;
      const artifacts: { readonly path: string; readonly sha256: string; readonly bytes: number }[] = [];

      switch (actionId) {
        case 'inspect_workbook':
          outputBody = { sheets: payload['sheets'] };
          break;
        case 'read_range':
          outputBody = { values: payload['values'] };
          break;
        case 'write_range':
          outputBody = { written: payload['written'] };
          break;
        case 'export_pdf': {
          const outPath = payload['out_path'];
          if (typeof outPath !== 'string') {
            throw new TorosError(ErrorCode.E_ADAPTER_FAILURE, 'export_pdf returned no out_path', {});
          }
          outputBody = { out_path: outPath };
          artifacts.push(await artifactFor(outPath));
          break;
        }
        default:
          outputBody = {};
      }

      const output = JSON.stringify(outputBody);
      const limit = action.output_limit_bytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
      if (Buffer.byteLength(output, 'utf8') > limit) {
        throw new TorosError(ErrorCode.E_OUTPUT_LIMIT, 'action output exceeded the byte limit', { limit });
      }

      return {
        output,
        truncated: false,
        artifacts,
        receipt_extra: { excel_pid: excel_pid },
      };
    },

    async dispose(): Promise<void> {
      // Nothing persistent to release: each action owns its temp directory and
      // COM lifecycle. Excel is closed by the script's finally block.
    },
  };

  return adapter;
}

/** The four action ids this adapter registers — the SPEC §10 surface. */
export const EXCEL_ACTION_IDS: readonly string[] = FOUR_ACTIONS;
