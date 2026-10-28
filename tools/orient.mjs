/**
 * Toros first-run orientation — spec AP.
 *
 * Answers the three questions a newcomer has before anything else: can I build
 * this, what will actually work on this machine, and what is in here. It is
 * read-only apart from `--init-config`, makes no network request unless asked,
 * and never prints a credential.
 *
 * Deliberately dependency-free and outside the workspace build, because the
 * first moment it is useful is on a fresh clone with no `node_modules/` and no
 * `dist/`. Nothing here may import outside `node:`.
 *
 *   node tools/orient.mjs [--json] [--check] [--init-config [path]] [--probe-models]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ findings */

export const OK = 'ok';
export const WARN = 'warn';
export const BLOCK = 'block';

/** A finding is the whole vocabulary of this tool: a level, where, what, and how to fix it. */
export function finding(level, area, title, detail = '', fix = '') {
  return { level, area, title, detail, fix };
}

/* --------------------------------------------------------------- executables */

/**
 * The agent families this build knows about. `bin` names are FIXED LITERALS:
 * nothing from a configuration file, an environment variable, or argv can
 * select what gets executed (spec AP, criterion 5). `probeCandidates` are
 * paths tried, relative to a shim's own directory, when PATH yields a shim.
 */
export const AGENT_FAMILIES = [
  {
    id: 'claude',
    bin: 'claude',
    role: 'CLI agent — registered read-only (Claude permission mode `plan`)',
    probeCandidates: ['node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
  },
  {
    id: 'codex',
    bin: 'codex',
    role: 'CLI agent — mutation-capable, sandbox pinned by the adapter',
    probeCandidates: ['node_modules/@openai/codex/bin/codex.exe'],
  },
  {
    id: 'grok',
    bin: 'grok',
    role: 'CLI agent — Grok Build on native Windows, sandbox pinned by the adapter',
    probeCandidates: [],
    // Grok Build installs under the user profile, not on PATH, and Gemini runs
    // through wsl.exe with a launcher arg — neither is discoverable by a PATH
    // probe, so both are verified only from the configured executable.
    configOnly: true,
  },
  {
    id: 'gemini',
    bin: 'gemini',
    role: 'CLI agent — Antigravity (AGY) via WSL, registered read-only',
    probeCandidates: [],
    configOnly: true,
  },
];

/** Executables the adapter refuses. Mirrors `CliSessionAdapter.init`. */
const SHIM_EXTENSIONS = ['.cmd', '.bat'];

/**
 * Classify a resolved executable the way `CliSessionAdapter.init` will.
 *
 * The interesting answer is `shim`. npm installs `claude` on Windows as
 * `claude.cmd`, which is what a newcomer finds on PATH, verifies by hand, and
 * writes into their config — and it is exactly what the adapter refuses,
 * inside a scheduled task where nobody reads the error.
 */
export function classifyExecutable(execPath, { nodePath = process.execPath } = {}) {
  if (!execPath) return 'absent';
  const lower = execPath.toLowerCase();
  if (execPath === nodePath) return 'usable';
  if (SHIM_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'shim';
  if (!lower.endsWith('.exe')) return 'not-exe';
  return 'usable';
}

/**
 * Pull the real target out of an npm cmd-shim.
 *
 * The shim invokes `node "%~dp0\node_modules\<pkg>\cli.js"`. That gives the
 * package directory, from which a native `<name>.exe` — when the package ships
 * one — is a short, bounded hop. The result is constrained to stay under the
 * shim's own directory: a shim is a text file, and a text file is not allowed
 * to point this tool at an arbitrary path.
 */
export function parseShimTarget(shimText, shimDir, name) {
  const match = /node_modules[\\/][^"'\r\n]*/.exec(shimText);
  if (!match) return null;
  const referenced = resolve(shimDir, match[0].trim().replace(/%~dp0[\\/]?/gi, ''));
  // A shim is a text file, and a text file is not allowed to point this tool
  // at an arbitrary path.
  if (!referenced.startsWith(shimDir)) return null;

  const packageDir = dirname(dirname(referenced));
  const native = findNativeExecutable(packageDir, name);
  return { jsEntry: existsSync(referenced) ? referenced : null, native };
}

/**
 * Search a package directory for a native `<name>.exe`.
 *
 * Necessary because the layout varies: `claude` ships one in its own `bin/`,
 * while `codex` nests the real binary six levels down in a per-platform
 * package (`node_modules/@openai/codex-win32-x64/vendor/<triple>/bin/codex.exe`).
 * Walking up from the shim's JS entry finds the first and misses the second.
 *
 * Bounded on depth and on entries examined, so a pathological tree cannot turn
 * orientation into a filesystem crawl. `bin/` hits win over any other.
 */
export function findNativeExecutable(packageDir, name, { maxDepth = 8, maxEntries = 5000 } = {}) {
  const target = `${name}.exe`.toLowerCase();
  const queue = [[packageDir, 0]];
  let examined = 0;
  let fallback = null;
  while (queue.length > 0) {
    const [dir, depth] = queue.shift();
    if (depth > maxDepth || examined > maxEntries) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      examined += 1;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push([full, depth + 1]);
      } else if (entry.name.toLowerCase() === target) {
        if (basename(dir).toLowerCase() === 'bin') return full;
        fallback ??= full;
      }
    }
  }
  return fallback;
}

/** Resolve a bare name on PATH, honouring PATHEXT on Windows. Returns every hit. */
export function resolveOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hits = [];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext.toLowerCase());
      try {
        if (statSync(candidate).isFile()) hits.push(candidate);
      } catch { /* unreadable PATH entry — not this tool's problem */ }
    }
  }
  return hits;
}

/**
 * Run a known-good executable with a FIXED argument vector to read its version.
 *
 * `shell: false` and a literal argv, and the caller has already established
 * that `execPath` is a real `.exe` — a `.cmd` is never executed here, which is
 * the same reason the adapter refuses one.
 */
export function readVersion(execPath, { run = spawnSync, timeout = 8000 } = {}) {
  try {
    const result = run(execPath, ['--version'], {
      timeout,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    const text = `${result.stdout ?? ''}`.trim().split(/\r?\n/)[0];
    return text ? text.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- config validation */

/**
 * Collect every non-empty string value under `config.agents`, wherever it sits.
 *
 * A credential is not only the recognised `agents.claude.token` / `agents.codex.token`
 * keys: a bare-string `agents.claude`, a token nested under a non-string `token`
 * key, or a string under `agents.gemini` are all strings that could surface in
 * rendered output (config JSON is echoed verbatim in some findings). Registering
 * only the two canonical keys lets any other string print.
 *
 * The walk is bounded: depth ≤ 4, and anything that is not a plain object,
 * array or string is ignored. Only non-empty strings are returned — a common
 * short word must not be able to poison the output scrub.
 */
export function collectAgentStringValues(agents, { maxDepth = 4 } = {}) {
  const out = [];
  const visit = (value, depth) => {
    if (depth > maxDepth) return;
    if (typeof value === 'string') {
      if (value.length > 0) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(agents, 0);
  return out;
}

/** The MCP discovery server entry the presence check looks for (extracted for tests). */
export function mcpPresenceFinding(agents, { exists = existsSync, repoRoot = REPO_ROOT } = {}) {
  // Core accepts a token only under `agents.claude.token` / `agents.codex.token`
  // (agent-config.ts `agentTokensFromConfig`). A token under `agents.gemini`, an
  // array element, or any other nesting does not make the stdio server useable.
  const claudeToken = agents?.claude?.token;
  const codexToken = agents?.codex?.token;
  const hasUsableToken = (typeof claudeToken === 'string' && claudeToken.length > 0)
    || (typeof codexToken === 'string' && codexToken.length > 0);
  if (!hasUsableToken) return null;
  const mcpMain = join(repoRoot, 'packages', 'mcp-discovery', 'dist', 'src', 'main.js');
  return exists(mcpMain)
    ? finding(OK, 'config', 'MCP discovery server is built', mcpMain)
    : finding(WARN, 'config', 'MCP discovery server is not built', mcpMain, 'npm run build');
}

/* ------------------------------------------------------- config validation */

/** Node Core tolerates a UTF-8 BOM (packages/node-core/src/main.ts). So does this. */
export function parseConfigText(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

/**
 * The only characters a token may contain: printable ASCII 0x21–0x7E (F1,
 * packages/node-core/src/core.ts). The HTTP header boundary strips surrounding
 * whitespace from a bearer value, so a token that differs from another only by
 * whitespace is indistinguishable on the wire. Refusing any character outside
 * this range — spaces, tabs and line breaks included — means whitespace can
 * never reach a comparison.
 */
const PRINTABLE_ASCII = /^[\x21-\x7E]*$/;

/**
 * Validate the node's `adapters.desktop.authorized_apps` config against the
 * same rule shapes @toros/node-core enforces at startup
 * (`validateDesktopAuthorizedApps`, amendment A8/F3b and A9). orient.mjs cannot
 * import that module — it must work on a fresh clone with no build — so the
 * three shapes are restated here exactly: `{ image_sha256 }`,
 * `{ signer, product_name, original_filename }`, or `{ image_path }`.
 *
 * Returns findings; an absent `value` (no desktop config) is valid and returns
 * nothing.
 */
function validateAuthorizedAppsRules(value) {
  if (value === undefined) return [];
  const out = [];
  const area = 'config';
  if (!Array.isArray(value)) {
    out.push(finding(BLOCK, area, '`adapters.desktop.authorized_apps` must be an array of application rules'));
    return out;
  }
  value.forEach((item, i) => {
    const at = `adapters.desktop.authorized_apps[${i}]`;
    if (typeof item === 'string') {
      out.push(finding(BLOCK, area, `\`${at}\` is a bare string`, JSON.stringify(item),
        'use an object with exactly one of { image_sha256 }, { signer, product_name, original_filename }, or { image_path }'));
      return;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      out.push(finding(BLOCK, area, `\`${at}\` must be an application rule object`));
      return;
    }
    for (const key of Object.keys(item)) {
      if (!['image_sha256', 'signer', 'product_name', 'original_filename', 'image_path'].includes(key)) {
        out.push(finding(BLOCK, area, `\`${at}\` has an unknown property`, key));
      }
    }
    const hasSha = 'image_sha256' in item;
    const hasSigner = 'signer' in item;
    const hasProduct = 'product_name' in item;
    const hasOriginal = 'original_filename' in item;
    const hasPath = 'image_path' in item;
    if (hasSha) {
      if (hasSigner || hasProduct || hasOriginal || hasPath) {
        out.push(finding(BLOCK, area, `\`${at}\` must have exactly one rule shape`));
      } else if (typeof item.image_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.image_sha256)) {
        out.push(finding(BLOCK, area, `\`${at}.image_sha256\` must be 64 lower-case hex characters`));
      }
    } else if (hasSigner || hasProduct || hasOriginal) {
      if (!hasSigner || !hasProduct || !hasOriginal || hasPath) {
        out.push(finding(BLOCK, area, `\`${at}\` signer, product_name and original_filename must appear together`));
      } else {
        if (typeof item.signer !== 'string' || item.signer.length === 0 || item.signer.length > 512) {
          out.push(finding(BLOCK, area, `\`${at}.signer\` must be a non-empty string ≤ 512 characters`));
        }
        if (typeof item.product_name !== 'string' || item.product_name.length === 0 || item.product_name.length > 512) {
          out.push(finding(BLOCK, area, `\`${at}.product_name\` must be a non-empty string ≤ 512 characters`));
        }
        if (typeof item.original_filename !== 'string' || item.original_filename.length === 0
          || item.original_filename.length > 260 || item.original_filename.includes('\\') || item.original_filename.includes('/')) {
          out.push(finding(BLOCK, area, `\`${at}.original_filename\` must be a non-empty string ≤ 260 characters with no path separators`));
        }
      }
    } else if (hasPath) {
      if (typeof item.image_path !== 'string' || item.image_path.length === 0 || item.image_path.length > 512) {
        out.push(finding(BLOCK, area, `\`${at}.image_path\` must be a non-empty string ≤ 512 characters`));
      } else if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)/.test(item.image_path)) {
        out.push(finding(BLOCK, area, `\`${at}.image_path\` must be absolute`));
      }
    } else {
      out.push(finding(BLOCK, area, `\`${at}\` must have exactly one rule shape`));
    }
  });
  return out;
}

/**
 * The agent names Node Core recognises (spec AT). `agent-config.ts` and
 * `agent-grants.ts` both derive from the two names `claude` and `codex`; any
 * other key under `agents` is ignored by Core, so it is a WARN here.
 */
const AGENT_NAMES = ['claude', 'codex'];

/**
 * Validate `agents.<name>`, mirroring the start-up checks Core runs (spec AT,
 * `core.ts:226-252` and `agent-config.ts`). Like Core, this applies the passes
 * in order across the whole bearer class — shape (in `agentTokensFromConfig`
 * and `assertPrintableAscii`), strength, then distinctness — so a malformed
 * entry blocks before a weak or shared one is even compared.
 *
 * `desktop_control.ar_gate_cleared` is validated only for its shape and value:
 * nothing here can confirm the driver-profile requirement, so orient warns
 * rather than probing ACLs.
 */
function validateAgentConfig(config) {
  const out = [];
  const area = 'config';
  const agents = config.agents;
  const configuredTokens = new Map();

  // Shape (agent-config.ts `agentTokensFromConfig`): agents must be an object;
  // `agents.claude` / `agents.codex`, each when present, an object with a string
  // `token`. Core throws on any of these, so they are BLOCKs. `null` is treated
  // like an absent `agents` (agentTokensFromConfig returns `{}` for it), so it
  // produces no finding here.
  if (agents !== undefined && agents !== null) {
    if (typeof agents !== 'object' || Array.isArray(agents)) {
      out.push(finding(BLOCK, area, '`agents` must be an object of `{ claude, codex }`',
        'Core refuses to start when `agents` is not an object'));
    } else {
      for (const name of AGENT_NAMES) {
        const entry = agents[name];
        if (entry === undefined) continue;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          out.push(finding(BLOCK, area, `\`agents.${name}\` must be an object with a \`token\``));
          continue;
        }
        const token = entry.token;
        if (typeof token !== 'string') {
          out.push(finding(BLOCK, area, `\`agents.${name}.token\` must be a string`));
          continue;
        }
        configuredTokens.set(name, token);
      }
      for (const key of Object.keys(agents)) {
        if (!AGENT_NAMES.includes(key)) {
          out.push(finding(WARN, area, `\`agents.${key}\` is not a recognised agent`, key,
            'Core ignores unknown agent keys; the recognised agents are `claude` and `codex`'));
        }
      }
    }
  }

  // Strength and shape of each token that passed the object/structure checks,
  // in Core's order: printable ASCII first (`assertPrintableAscii` runs before
  // the length and distinctness checks, `core.ts:232-251`).
  for (const name of AGENT_NAMES) {
    const token = configuredTokens.get(name);
    if (token === undefined) continue;
    if (!PRINTABLE_ASCII.test(token)) {
      out.push(finding(BLOCK, area, `\`agents.${name}.token\` must contain only printable ASCII (0x21–0x7E), with no spaces, tabs or line breaks`,
        'whitespace would be stripped at the HTTP header boundary, making two tokens indistinguishable on the wire'));
      continue;
    }
    if (token.length < 32) {
      out.push(finding(BLOCK, area, `\`agents.${name}.token\` must be at least 32 characters`));
      continue;
    }
    // Distinctness, in Core's order (core.ts:242-251): differ from `token`,
    // from `operator_token` (when set), then from the other agent's token.
    if (typeof config.token === 'string' && token === config.token) {
      out.push(finding(BLOCK, area, `\`agents.${name}.token\` must differ from \`token\``,
        `\`agents.${name}.token\` and \`token\` are currently identical`));
    }
    if (typeof config.operator_token === 'string' && config.operator_token.length > 0 && token === config.operator_token) {
      out.push(finding(BLOCK, area, `\`agents.${name}.token\` must differ from \`operator_token\``,
        `\`agents.${name}.token\` and \`operator_token\` are currently identical`));
    }
    // A token that failed shape/strength already cannot also be a valid bearer,
    // so the OK finding is emitted only when it passed all three passes above.
    const other = AGENT_NAMES.find((n) => n !== name);
    const otherToken = configuredTokens.get(other);
    if (otherToken !== undefined && token === otherToken) {
      out.push(finding(BLOCK, area, `\`agents.${name}.token\` must differ from \`agents.${other}.token\``,
        `\`agents.${name}.token\` and \`agents.${other}.token\` are currently identical`));
    } else if (PRINTABLE_ASCII.test(token) && token.length >= 32
      && token !== config.token
      && !(typeof config.operator_token === 'string' && config.operator_token.length > 0 && token === config.operator_token)) {
      out.push(finding(OK, area, `\`agents.${name}.token\` present and distinct`, `${token.length} characters`));
    }
  }

  // Desktop gate (agent-config.ts `desktopArGateCleared`): strict `=== true`,
  // fail-closed. Core treats a non-object `desktop_control` as gate closed.
  const desktopControl = config.desktop_control;
  const hasAgentToken = configuredTokens.size > 0;
  const gateClosedText = 'only the boolean `true` opens the gate; agents get `machine.inventory` only';
  if (desktopControl === undefined) {
    if (hasAgentToken) {
      // Absent gate with a token configured: same text as the wrong-value case.
      out.push(finding(WARN, area, gateClosedText));
    }
    // Absent with no agent token: nothing.
  } else if (typeof desktopControl !== 'object' || desktopControl === null || Array.isArray(desktopControl)) {
    out.push(finding(WARN, area, '`desktop_control` must be an object', '',
      'Core treats a non-object `desktop_control` as the gate closed'));
  } else if (desktopControl.ar_gate_cleared === true) {
    out.push(finding(OK, area, 'desktop discovery open to agents'));
  } else if ('ar_gate_cleared' in desktopControl) {
    out.push(finding(WARN, area, gateClosedText,
      `the configured value is a ${typeof desktopControl.ar_gate_cleared}`));
  } else if (hasAgentToken) {
    out.push(finding(WARN, area, gateClosedText));
  }

  // Driver-profile requirement (spec AT): orient cannot confirm the agent's CLI
  // profile cannot read %LOCALAPPDATA%\Toros, so while a token is configured the
  // warning is unconditional.
  if (hasAgentToken) {
    out.push(finding(WARN, area, 'agent driver profile cannot be confirmed',
      'the agent\'s CLI must run under a profile that cannot read %LOCALAPPDATA%\\Toros; otherwise it can read the other bearers',
      'run the agent CLI as a separate Windows user, or deny its profile read access to the Toros config directory'));
  }

  return out;
}

/**
 * Validate `config.json` against the rules Node Core enforces at startup, so a
 * configuration that passes here starts a node. Pure: all filesystem questions
 * arrive through `exists`, so the whole rule set is testable without a disk.
 */
export function validateNodeConfig(config, { exists = existsSync } = {}) {
  const out = [];
  const area = 'config';

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return [finding(BLOCK, area, 'config.json must contain an object')];
  }

  if (typeof config.token !== 'string' || config.token.length < 32) {
    out.push(finding(BLOCK, area, '`token` must be a string of at least 32 characters', '',
      'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"'));
  } else if (!PRINTABLE_ASCII.test(config.token)) {
    out.push(finding(BLOCK, area, '`token` must contain only printable ASCII (0x21–0x7E), with no spaces, tabs or line breaks',
      'whitespace would be stripped at the HTTP header boundary, making two tokens indistinguishable on the wire'));
  } else {
    out.push(finding(OK, area, '`token` present', `${config.token.length} characters`));
  }

  if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
    out.push(finding(BLOCK, area, '`workspaces` must be a non-empty array'));
  } else {
    for (const workspace of config.workspaces) {
      const root = workspace?.root;
      if (typeof root !== 'string' || !isAbsolute(root)) {
        out.push(finding(BLOCK, area, `workspace \`${workspace?.id ?? '?'}\` root must be an absolute path`));
      } else if (!exists(root)) {
        out.push(finding(BLOCK, area, `workspace root does not exist`, root, 'create the directory, or correct the path'));
      } else {
        out.push(finding(OK, area, `workspace \`${workspace.id}\``, root));
      }
    }
  }

  const approvals = Array.isArray(config.approval_required) ? config.approval_required : [];
  const operatorToken = config.operator_token;
  if (operatorToken === undefined) {
    if (approvals.length > 0) {
      out.push(finding(BLOCK, area, '`operator_token` is required when `approval_required` is non-empty',
        `${approvals.length} gated capability/capabilities`,
        'Node Core refuses to start rather than leave a gate nobody can open'));
    } else {
      out.push(finding(WARN, area, '`operator_token` is not set',
        'the cockpit findings and approvals views need it',
        'add a second 32-byte hex token, different from `token`'));
    }
  } else if (typeof operatorToken !== 'string' || operatorToken.length < 32) {
    out.push(finding(BLOCK, area, '`operator_token` must be a string of at least 32 characters'));
  } else if (!PRINTABLE_ASCII.test(operatorToken)) {
    out.push(finding(BLOCK, area, '`operator_token` must contain only printable ASCII (0x21–0x7E), with no spaces, tabs or line breaks'));
  } else if (operatorToken === config.token) {
    out.push(finding(BLOCK, area, '`operator_token` must differ from `token`',
      'they are currently identical',
      'the party being gated could otherwise open its own gate'));
  } else {
    out.push(finding(OK, area, '`operator_token` present and distinct', `${operatorToken.length} characters`));
  }

  if (typeof config.db_path === 'string' && config.db_path.length > 0) {
    if (!exists(dirname(config.db_path))) {
      out.push(finding(BLOCK, area, "`db_path`'s parent directory does not exist", dirname(config.db_path)));
    }
  } else {
    out.push(finding(BLOCK, area, '`db_path` must be a non-empty string'));
  }

  if (typeof config.port !== 'number' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    out.push(finding(BLOCK, area, '`port` must be an integer between 1 and 65535'));
  }

  for (const [id, spec] of Object.entries(config.adapters ?? {})) {
    const executable = spec?.executable;
    if (typeof executable !== 'string' || executable.length === 0) continue;
    if (!exists(executable)) {
      out.push(finding(BLOCK, area, `adapter \`${id}\` executable does not exist`, executable));
      continue;
    }
    const kind = classifyExecutable(executable);
    if (kind === 'shim') {
      out.push(finding(BLOCK, area, `adapter \`${id}\` points at a .cmd/.bat shim`, executable,
        'the adapter refuses these at init — configure the real .exe'));
    } else if (kind === 'not-exe') {
      out.push(finding(BLOCK, area, `adapter \`${id}\` executable is not a .exe`, executable,
        'only a real .exe, or the Node runtime itself, is accepted'));
    } else {
      out.push(finding(OK, area, `adapter \`${id}\` executable`, executable));
    }
  }

  if (typeof config.coordinator_entry === 'string' && !exists(config.coordinator_entry)) {
    out.push(finding(BLOCK, area, '`coordinator_entry` does not exist', config.coordinator_entry,
      'Node Core verifies this once at startup and refuses to start without it'));
  }

  // F3b/A9: the desktop application allowlist must be valid AppRule shapes, the
  // same rules Node Core enforces at startup (validateDesktopAuthorizedApps).
  out.push(...validateAuthorizedAppsRules(config.adapters?.desktop?.authorized_apps));

  // Spec AT: agent discovery bearers and the desktop AR gate (`core.ts:226-252`,
  // `agent-config.ts`).
  out.push(...validateAgentConfig(config));

  return out;
}

/* ------------------------------------------------------------- collectors */

function readJsonIfPresent(path) {
  try {
    return parseConfigText(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function majorOf(version) {
  const match = /(\d+)/.exec(version ?? '');
  return match ? Number(match[1]) : NaN;
}

function collectEnvironment() {
  const out = [];
  const area = 'environment';

  const pkg = readJsonIfPresent(join(REPO_ROOT, 'package.json')) ?? {};
  const required = majorOf(pkg.engines?.node ?? '>=24');
  const actual = majorOf(process.versions.node);
  if (Number.isFinite(required) && actual < required) {
    out.push(finding(BLOCK, area, `Node ${process.versions.node} is below the required major ${required}`,
      `package.json engines.node = ${pkg.engines?.node}`,
      'node:sqlite and node:test are used as built-ins'));
  } else {
    out.push(finding(OK, area, `Node ${process.versions.node}`, `engines.node = ${pkg.engines?.node ?? 'unset'}`));
  }

  if (process.platform !== 'win32') {
    out.push(finding(WARN, area, `platform is ${process.platform}, not win32`,
      'every adapter manifest declares platforms: [\'win32\']',
      'packages build and test here; no adapter will register, and the cockpit installer is Windows-only'));
  } else {
    out.push(finding(OK, area, 'platform win32'));
  }

  for (const [name, level, note] of [
    ['npm', BLOCK, 'required to install workspace dependencies'],
    ['git', WARN, 'required to contribute, not to build'],
    ['cargo', WARN, 'cockpit only — packages build without it'],
    ['rustc', WARN, 'cockpit only — packages build without it'],
  ]) {
    const hits = resolveOnPath(name);
    if (hits.length === 0) {
      out.push(finding(level, area, `${name} not found on PATH`, '', note));
    } else {
      const kind = classifyExecutable(hits[0]);
      // npm and cargo ship as shims on Windows; that is fine for a human shell.
      // The .exe rule is an adapter rule, not a toolchain rule.
      const version = kind === 'usable' ? readVersion(hits[0]) : null;
      out.push(finding(OK, area, name, version ?? hits[0]));
    }
  }

  const built = existsSync(join(REPO_ROOT, 'packages', 'contracts', 'dist'));
  out.push(built
    ? finding(OK, area, 'workspace is built', 'packages/*/dist present')
    : finding(WARN, area, 'workspace is not built', '', 'npm install && npm run build'));

  const installed = existsSync(join(REPO_ROOT, 'node_modules'));
  if (!installed) out.push(finding(WARN, area, 'dependencies are not installed', '', 'npm install'));

  return out;
}

/**
 * Resolve each agent family and report it.
 *
 * Also returns the executable `--verify-agents` should drive, so the two
 * sections can never disagree about which binary they are talking about.
 */
function collectAgents() {
  const out = [];
  const area = 'agents';
  /** family id -> the usable executable, when there is one. */
  const usableExecutables = new Map();

  for (const family of AGENT_FAMILIES) {
    // Config-only families (Grok, Gemini) are never on PATH; a probe here would
    // only ever report a misleading "not installed". They surface through the
    // configured executable and are exchange-verified by `--verify-agents`.
    if (family.configOnly) continue;
    const hits = resolveOnPath(family.bin);
    if (hits.length === 0) {
      out.push(finding(WARN, area, `${family.id} — not installed`, family.role,
        `Toros registers this family only when its executable is configured; without it the ${family.id} lifecycle is unavailable`));
      continue;
    }

    const usable = hits.find((hit) => classifyExecutable(hit) === 'usable');
    if (usable) {
      usableExecutables.set(family.id, usable);
      const version = readVersion(usable);
      out.push(finding(OK, area, `${family.id} — usable`, `${usable}${version ? ` (${version})` : ''}`, family.role));
      continue;
    }

    // Only a shim on PATH. Find what to configure instead, and say it exactly —
    // this is the finding the whole section exists for.
    const shim = hits[0];
    let native = null;
    let jsEntry = null;
    for (const candidate of family.probeCandidates) {
      const probe = resolve(dirname(shim), candidate);
      if (existsSync(probe)) { native = probe; break; }
    }
    if (!native) {
      try {
        const parsed = parseShimTarget(readFileSync(shim, 'utf8'), dirname(shim), family.bin);
        native = parsed?.native ?? null;
        jsEntry = parsed?.jsEntry ?? null;
      } catch { /* unreadable shim — the finding below still names the problem */ }
    }

    let fix;
    if (native) {
      fix = `configure the real executable instead: ${native}`;
    } else if (jsEntry) {
      // The adapter also accepts the Node runtime itself, which is the correct
      // answer for a package that ships only a JS entry point.
      fix = `no native .exe in this package — configure the Node runtime with the entry as a launcher arg: `
        + `"executable": "${process.execPath}", "launcher_args": ["${jsEntry}"]`;
    } else {
      fix = 'the adapter refuses .cmd/.bat; locate the package\'s native .exe and configure that path';
    }

    // The real executable behind a shim is still a usable target to verify,
    // even though the operator has not configured it yet.
    if (native) usableExecutables.set(family.id, native);
    out.push(finding(WARN, area, `${family.id} — PATH has a shim the adapter refuses`, shim, fix));
  }

  return { findings: out, usableExecutables };
}

function collectConfiguration({ localAppData = process.env.LOCALAPPDATA } = {}) {
  const out = [];
  const secrets = [];
  const area = 'config';
  /** adapter id -> executable, as the operator configured it. */
  const configuredExecutables = new Map();
  /** adapter id -> { launcher_args, args }, so verification runs it as a real job would. */
  const configuredSpecs = new Map();

  if (!localAppData) {
    out.push(finding(WARN, area, 'LOCALAPPDATA is not set',
      'the installed configuration path is %LOCALAPPDATA%\\Toros',
      'expected on a non-Windows host'));
    return { findings: out, secrets, coordinator: undefined, configuredExecutables, configuredSpecs };
  }

  const configPath = join(localAppData, 'Toros', 'config.json');
  if (!existsSync(configPath)) {
    out.push(finding(WARN, area, 'no node configuration', configPath,
      'node tools/orient.mjs --init-config   (writes a starter file; never overwrites)'));
  } else {
    let config;
    try {
      config = parseConfigText(readFileSync(configPath, 'utf8'));
    } catch (error) {
      out.push(finding(BLOCK, area, 'config.json does not parse', configPath, String(error.message ?? error)));
      return { findings: out, secrets, coordinator: undefined, configuredExecutables, configuredSpecs };
    }
    // Register credential values for the output scrub before anything renders.
    for (const key of ['token', 'operator_token']) {
      if (typeof config[key] === 'string' && config[key].length > 0) secrets.push(config[key]);
    }
    // Agent discovery bearers (spec AT): every non-empty string value anywhere
    // under `agents` is a bearer-class credential and must be registered before
    // anything renders, exactly like `token` and `operator_token`, or
    // `scrubOrThrow` could let one out. This covers the canonical
    // `agents.claude.token` / `agents.codex.token` and any other string the
    // config carries (a bare-string `agents.claude`, a token under `agents.gemini`,
    // a string nested under a non-string `token`).
    secrets.push(...collectAgentStringValues(config.agents));
    out.push(finding(OK, area, 'node configuration found', configPath));
    out.push(...validateNodeConfig(config));
    // MCP discovery server presence (spec AT2/AT3): a configured agent token is
    // only usable when the stdio server it drives has been built. Keyed off the
    // same condition Core uses — a non-empty string `agents.claude.token` /
    // `agents.codex.token` — so a token under `agents.gemini` does not count.
    const mcpFinding = mcpPresenceFinding(config.agents);
    if (mcpFinding) out.push(mcpFinding);
    // What the operator configured is what a run would actually use, so it
    // outranks whatever happens to be first on PATH.
    for (const [id, spec] of Object.entries(config.adapters ?? {})) {
      if (typeof spec?.executable === 'string' && spec.executable.length > 0) {
        configuredExecutables.set(id, spec.executable);
        configuredSpecs.set(id, {
          launcher_args: Array.isArray(spec.launcher_args) ? spec.launcher_args : [],
          args: Array.isArray(spec.args) ? spec.args : [],
        });
      }
    }
  }

  const coordinatorPath = join(localAppData, 'Toros', 'coordinator.json');
  let coordinator;
  if (!existsSync(coordinatorPath)) {
    out.push(finding(WARN, 'models', 'no coordinator configuration', coordinatorPath,
      'Hermes needs a model endpoint; see docs/DEPLOY.md'));
  } else {
    try {
      coordinator = parseConfigText(readFileSync(coordinatorPath, 'utf8'));
    } catch (error) {
      out.push(finding(BLOCK, 'models', 'coordinator.json does not parse', coordinatorPath, String(error.message ?? error)));
      coordinator = undefined;
    }
    if (coordinator) {
      if (typeof coordinator.api_key === 'string') secrets.push(coordinator.api_key);
      const model = typeof coordinator.model === 'string' ? coordinator.model : null;
      const baseUrl = typeof coordinator.base_url === 'string' ? coordinator.base_url : null;
      out.push(model && baseUrl
        ? finding(OK, 'models', 'coordinator model configured', `${model} via ${baseUrl}`)
        : finding(BLOCK, 'models', 'coordinator.json needs both `model` and `base_url`'));
      out.push(typeof coordinator.api_key === 'string' && coordinator.api_key.length > 0
        ? finding(OK, 'models', '`api_key` present', `${coordinator.api_key.length} characters — value never printed`)
        : finding(BLOCK, 'models', '`api_key` is missing or empty'));
    }
  }

  return { findings: out, secrets, coordinator, configuredExecutables, configuredSpecs };
}

/**
 * The one outbound request this tool can make, and only behind --probe-models.
 *
 * The key travels as an Authorization header, never in the URL. A failure is
 * reported as its status code and nothing else: a provider's error body can
 * quote the credential back, and this output is meant to be pasteable.
 */
async function probeModels(coordinator) {
  const area = 'models';
  if (!coordinator?.base_url || !coordinator?.api_key) {
    return [finding(WARN, area, '--probe-models needs `base_url` and `api_key` in coordinator.json')];
  }
  const base = coordinator.base_url.endsWith('/') ? coordinator.base_url.slice(0, -1) : coordinator.base_url;
  try {
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${coordinator.api_key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return [finding(WARN, area, `provider returned HTTP ${response.status}`, '',
        'response body withheld — it can echo the credential')];
    }
    const body = await response.json();
    const ids = (Array.isArray(body?.data) ? body.data : [])
      .map((entry) => (typeof entry?.id === 'string' ? entry.id : null))
      .filter(Boolean)
      .sort();
    const configured = typeof coordinator.model === 'string' ? coordinator.model : null;
    const results = [finding(OK, area, `provider offers ${ids.length} model(s)`, ids.slice(0, 40).join(', '))];
    if (configured) {
      results.push(ids.includes(configured)
        ? finding(OK, area, `configured model \`${configured}\` is offered`)
        : finding(BLOCK, area, `configured model \`${configured}\` is not in the provider's list`, '',
          'a run will fail at the first model request'));
    }
    return results;
  } catch (error) {
    return [finding(WARN, area, 'could not reach the provider', '',
      `${error?.name ?? 'error'} — body and message withheld`)];
  }
}

/* ------------------------------------------------------- agent verification */

/**
 * The prompt every verified agent is asked. A fixed literal: nothing from the
 * configuration, the environment, or argv reaches it.
 *
 * Deliberately trivial and answerable without touching anything. The point is
 * whether a turn completes at all, not what the model says.
 */
const VERIFY_PROMPT = 'Reply with the single word TOROSOK and nothing else.';
const VERIFY_TOKEN = 'TOROSOK';

/** How long one verification exchange may take before it is a failure. */
const VERIFY_TIMEOUT_MS = 90_000;

/**
 * Actually drive each agent through one exchange.
 *
 * This is the only part of orientation that RUNS an agent, which is why it is
 * behind its own flag. Everything else asks whether a binary is present and
 * what shape it is — and that is what reported `claude — usable` on a machine
 * where the adapter could not complete a single exchange, and printed "no
 * blockers" while nothing worked.
 *
 * Bounded deliberately: the sandbox is pinned `read-only` (Claude's
 * `--permission-mode plan`, codex's `-s read-only`), the workspace is a fresh
 * temporary directory removed afterwards, the prompt is a fixed literal, and
 * the exchange has a hard deadline after which the child is terminated.
 *
 * The outcomes are separated because they have different fixes:
 *   - cannot start          -> the configured executable is wrong
 *   - starts, never returns -> binary and credentials are fine; a model turn
 *                              that does not come back is a runtime or account
 *                              condition, not a Toros configuration
 *   - completes             -> this agent can actually do work here
 */
/**
 * Turn one exchange's outcome into a finding.
 *
 * Separated from the I/O so the judgement can be tested without an agent, and
 * because the distinction it draws is the point of the whole flag: "could not
 * start" and "started but the turn never returned" are different failures with
 * different fixes, and collapsing them sends an operator to the wrong file.
 */
export function classifyExchange(family, { state, text, exchangeError, seconds }) {
  const area = 'verify';
  if (state === 'succeeded' && String(text).includes(VERIFY_TOKEN)) {
    return finding(OK, area, `${family.id} — completed an exchange`, `${seconds}s`, family.role);
  }
  if (state === 'succeeded') {
    return finding(WARN, area, `${family.id} — completed, but did not answer`, `${seconds}s`,
      'the lifecycle works; the reply did not contain the expected word');
  }
  if (exchangeError === 'E_TIMEOUT' || state === 'running') {
    return finding(BLOCK, area, `${family.id} — starts, but the turn never returns`,
      `gave up after ${seconds}s`,
      'the binary runs and its credentials are found; a model turn that does not come back is a runtime or account condition, not a Toros configuration');
  }
  return finding(BLOCK, area, `${family.id} — exchange ${state}`, exchangeError ?? '',
    'the agent started but the exchange did not succeed');
}

async function verifyAgents(resolved, specs = new Map()) {
  const out = [];
  const area = 'verify';
  const entry = join(REPO_ROOT, 'packages', 'adapters-cli', 'dist', 'src', 'index.js');
  if (!existsSync(entry)) {
    return [finding(WARN, area, 'agent verification needs a build', '', 'npm install && npm run build')];
  }

  let module;
  try {
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    return [finding(WARN, area, 'could not load the CLI adapters', '', String(error?.message ?? error).slice(0, 160))];
  }

  const factories = {
    claude: module.createClaudeAdapter,
    codex: module.createCodexAdapter,
    grok: module.createGrokAdapter,
    gemini: module.createGeminiAdapter,
  };

  for (const family of AGENT_FAMILIES) {
    const executable = resolved.get(family.id);
    if (executable === undefined) {
      out.push(finding(WARN, area, `${family.id} — not verified`, 'no usable executable to verify',
        'install it, or point the configuration at a real .exe'));
      continue;
    }
    const factory = factories[family.id];
    if (typeof factory !== 'function') {
      out.push(finding(WARN, area, `${family.id} — no adapter factory`, '', 'tools/orient.mjs needs updating'));
      continue;
    }

    // Gemini needs its `-e /snap/bin/agy` launcher, and each worker its
    // configured args, or verification would not run the binary a real job runs.
    const spec = specs.get(family.id) ?? {};
    const root = mkdtempSync(join(tmpdir(), `toros-verify-${family.id}-`));
    const adapter = factory({
      executable,
      launcher_args: Array.isArray(spec.launcher_args) ? spec.launcher_args : [],
      args: Array.isArray(spec.args) ? spec.args : [],
      sandbox: 'read-only',
      timeout_ms: VERIFY_TIMEOUT_MS,
      exchange_timeout_ms: VERIFY_TIMEOUT_MS,
      output_limit_bytes: 4 * 1024 * 1024,
    });
    const context = {
      job_id: 'orient-verify',
      session_id: 'verify',
      correlation_id: 'verify',
      workspace: { id: 'verify', root },
      signal: new AbortController().signal,
    };

    const started = Date.now();
    try {
      await adapter.init();
      await adapter.start(context);
      await adapter.send('verify', VERIFY_PROMPT);

      let cursor = 0;
      let state = 'running';
      let text = '';
      let exchangeError = null;
      const deadline = started + VERIFY_TIMEOUT_MS + 15_000;
      while (state === 'running' && Date.now() < deadline) {
        const read = await adapter.read('verify', cursor);
        cursor = read.cursor ?? cursor;
        text += read.chunk ?? '';
        state = read.exchange_state ?? state;
        if (read.exchange_error) exchangeError = read.exchange_error;
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      out.push(classifyExchange(family, { state, text, exchangeError, seconds }));
    } catch (error) {
      out.push(finding(BLOCK, area, `${family.id} — could not start`,
        String(error?.code ?? error?.message ?? error).slice(0, 120),
        `check the configured executable: ${executable}`));
    } finally {
      try { await adapter.stop('verify'); } catch { /* already gone */ }
      try { await adapter.dispose(); } catch { /* already gone */ }
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* leave it */ }
    }
  }

  return out;
}

/**
 * What the real-binary test suites will do on THIS machine, and why.
 *
 * Read-only and cheap, so it runs by default. A suite that skips is invisible
 * in a green summary: the codex suite skipped for weeks because the path it
 * named had stopped existing, while STATUS.md blamed a provider quota. Both
 * the paths and the preflight rules come from the suites' own modules, so this
 * cannot drift from what they actually do.
 */
async function collectRealBinarySuites() {
  const out = [];
  const area = 'suites';
  const dist = join(REPO_ROOT, 'packages', 'adapters-cli', 'dist', 'test');
  const pathsEntry = join(dist, 'real-binary-paths.js');
  const preflightEntry = join(dist, 'real-test-preflight.js');
  if (!existsSync(pathsEntry) || !existsSync(preflightEntry)) {
    return [finding(WARN, area, 'real-binary suite status needs a build', '', 'npm install && npm run build')];
  }

  let paths;
  let preflight;
  try {
    paths = await import(pathToFileURL(pathsEntry).href);
    preflight = await import(pathToFileURL(preflightEntry).href);
  } catch (error) {
    return [finding(WARN, area, 'could not read the suite preflight', '', String(error?.message ?? error).slice(0, 160))];
  }

  const suites = [
    { id: 'codex', executable: paths.REAL_CODEX_EXECUTABLE, check: preflight.codexRealTestPreflight },
    { id: 'claude', executable: paths.REAL_CLAUDE_EXECUTABLE, check: preflight.claudeRealTestPreflight },
  ];

  for (const suite of suites) {
    if (typeof suite.check !== 'function' || typeof suite.executable !== 'string') continue;
    const verdict = suite.check(suite.executable);
    out.push(verdict.run
      ? finding(OK, area, `real ${suite.id} suite will RUN`, suite.executable)
      : finding(WARN, area, `real ${suite.id} suite will SKIP`, suite.executable,
        `${verdict.skip} — a skipped suite is not a passing one`));
  }
  return out;
}

/* ------------------------------------------------------------ codebase map */

function countFiles(dir, extension) {
  try {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension)).length;
  } catch {
    return 0;
  }
}

function collectMap() {
  const out = [];
  const area = 'map';
  const packagesDir = join(REPO_ROOT, 'packages');
  const packages = [];

  let names = [];
  try {
    names = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    out.push(finding(BLOCK, area, 'packages/ is unreadable', packagesDir));
    return { findings: out, packages, specs: [], capabilities: [] };
  }

  for (const name of names) {
    const manifest = readJsonIfPresent(join(packagesDir, name, 'package.json'));
    if (!manifest) continue;
    const entry = {
      name: manifest.name ?? name,
      description: manifest.description ?? null,
      sourceFiles: countFiles(join(packagesDir, name, 'src'), '.ts'),
      testFiles: countFiles(join(packagesDir, name, 'test'), '.ts'),
    };
    packages.push(entry);
    if (!entry.description) {
      out.push(finding(WARN, area, `package \`${entry.name}\` has no description`, '',
        'the map is derived from package.json — an empty description is an empty map entry'));
    }
  }

  const specs = [];
  const specsDir = join(REPO_ROOT, 'docs', 'specs');
  try {
    for (const file of readdirSync(specsDir).filter((f) => f.endsWith('.md')).sort()) {
      const text = readFileSync(join(specsDir, file), 'utf8');
      const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? file).trim();
      const status = (/^Status:\s*(.+)$/m.exec(text)?.[1] ?? '').trim();
      specs.push({ file, title, status });
    }
  } catch {
    out.push(finding(WARN, area, 'docs/specs is unreadable', specsDir));
  }

  return { findings: out, packages, specs };
}

/**
 * Read the capability inventory from the built adapter manifests.
 *
 * Constructing an adapter is inert — the constructors assign fields and build
 * a manifest object; `init()`, which validates paths and spawns, is never
 * called here. Placeholder options exist only to satisfy the constructor
 * signature and reach `.manifest`; none of them is used.
 */
async function collectCapabilities() {
  const out = [];
  const area = 'capabilities';
  const capabilities = [];

  const targets = [
    { pkg: 'adapters-cli', factory: 'createClaudeAdapter', options: { executable: 'placeholder.exe', args: [], timeout_ms: 1000, output_limit_bytes: 1024 } },
    { pkg: 'adapters-cli', factory: 'createCodexAdapter', options: { executable: 'placeholder.exe', args: [], timeout_ms: 1000, output_limit_bytes: 1024 } },
    { pkg: 'adapters-app', factory: 'createExcelAdapter', options: { executable: 'placeholder.exe', timeout_ms: 1000, max_cells: 1 } },
    // A placeholder domain, not an empty list: this constructor is the one that
    // validates, and an empty allowlist is the thing it refuses.
    { pkg: 'adapters-chrome', factory: 'createChromeWorkerAdapter', options: { allowed_domains: ['example.invalid'], state_path: 'placeholder.json' } },
  ];

  let anyLoaded = false;
  for (const target of targets) {
    const entry = join(REPO_ROOT, 'packages', target.pkg, 'dist', 'src', 'index.js');
    if (!existsSync(entry)) continue;
    try {
      const module = await import(pathToFileURL(entry).href);
      if (typeof module[target.factory] !== 'function') {
        out.push(finding(WARN, area, `\`${target.pkg}\` no longer exports \`${target.factory}\``, '',
          'the inventory is derived from these factories — update tools/orient.mjs'));
        continue;
      }
      const manifest = module[target.factory](target.options)?.manifest;
      if (!manifest) {
        out.push(finding(WARN, area, `\`${target.factory}\` returned no manifest`));
        continue;
      }
      anyLoaded = true;
      capabilities.push({
        id: manifest.id,
        version: manifest.version,
        platforms: manifest.platforms,
        permissions: manifest.required_permissions,
        actions: manifest.actions.map((action) => ({
          id: `${manifest.id}.${action.id}`,
          summary: action.summary,
          mutates: action.mutates === true,
          alwaysRequiresApproval: action.always_requires_approval === true,
        })),
      });
    } catch (error) {
      out.push(finding(WARN, area, `could not read the \`${target.pkg}\` manifest`, '',
        `${error?.name ?? 'error'}: ${String(error?.message ?? '').slice(0, 160)}`));
    }
  }

  if (!anyLoaded) {
    out.push(finding(WARN, area, 'capability inventory needs a build', '', 'npm install && npm run build'));
  }

  return { findings: out, capabilities };
}

/* --------------------------------------------------------------- init-config */

function initConfig(target) {
  const area = 'config';
  const path = target ?? join(process.env.LOCALAPPDATA ?? REPO_ROOT, 'Toros', 'config.json');
  if (existsSync(path)) {
    // No --force, deliberately: the file this would destroy holds credentials
    // that exist nowhere else.
    return [finding(BLOCK, area, 'config.json already exists — refusing to overwrite', path,
      'delete or move it yourself if you truly mean to replace it')];
  }
  const token = randomBytes(32).toString('hex');
  let operatorToken = randomBytes(32).toString('hex');
  while (operatorToken === token) operatorToken = randomBytes(32).toString('hex');

  const workspaceRoot = join(dirname(path), 'workspaces');
  const starter = {
    node_id: 'local',
    db_path: join(dirname(path), 'toros.db'),
    port: 8787,
    token,
    operator_token: operatorToken,
    workspaces: [{ id: 'sandbox', root: workspaceRoot }],
    adapters: {},
    approval_required: [],
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    return [finding(BLOCK, area, 'could not write the starter configuration', path, String(error?.message ?? error))];
  }

  const out = [
    finding(OK, area, 'starter configuration written', path,
      'two independent 32-byte tokens were generated; no adapter is configured yet'),
  ];
  out.push(process.platform === 'win32'
    ? finding(WARN, area, 'file permissions are inherited, not set', path,
      'on Windows the mode bits above are not the access control — confirm this path is not readable by other accounts')
    : finding(OK, area, 'file created mode 0600', path));
  return out;
}

/* ------------------------------------------------------------------ render */

const LEVEL_MARK = { [OK]: '  ok  ', [WARN]: ' warn ', [BLOCK]: 'BLOCK ' };

function renderReport(sections, { packages, specs, capabilities }) {
  const lines = ['', 'Toros — orientation', '='.repeat(60)];

  for (const [heading, findings] of sections) {
    if (findings.length === 0) continue;
    lines.push('', heading, '-'.repeat(heading.length));
    for (const item of findings) {
      lines.push(`${LEVEL_MARK[item.level]} ${item.title}${item.detail ? `  ${item.detail}` : ''}`);
      if (item.fix) lines.push(`        -> ${item.fix}`);
    }
  }

  if (packages.length > 0) {
    lines.push('', 'Packages', '-'.repeat(8));
    const width = Math.max(...packages.map((p) => p.name.length));
    for (const pkg of packages) {
      lines.push(`  ${pkg.name.padEnd(width)}  ${pkg.sourceFiles} src / ${pkg.testFiles} test`);
      if (pkg.description) lines.push(`  ${' '.repeat(width)}  ${pkg.description}`);
    }
  }

  if (capabilities.length > 0) {
    const total = capabilities.reduce((sum, adapter) => sum + adapter.actions.length, 0);
    lines.push('', `Capabilities (${total} across ${capabilities.length} adapters)`, '-'.repeat(20));
    for (const adapter of capabilities) {
      lines.push(`  ${adapter.id} v${adapter.version}  [${adapter.platforms.join(', ')}]  needs: ${adapter.permissions.join(', ') || 'nothing'}`);
      for (const action of adapter.actions) {
        const flags = [action.mutates ? 'mutates' : 'read-only', action.alwaysRequiresApproval ? 'always-approved' : null]
          .filter(Boolean).join(', ');
        lines.push(`    ${action.id.padEnd(28)} ${action.summary}  (${flags})`);
      }
    }
  }

  if (specs.length > 0) {
    lines.push('', `Specifications (${specs.length})`, '-'.repeat(14));
    lines.push('  docs/SPEC.md is the system specification; each file below is one slice.');
    for (const spec of specs) {
      lines.push(`  ${spec.file.padEnd(38)} ${spec.status || '—'}`);
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ scrub */

/**
 * Last line of defence, not the first: nothing above is supposed to place a
 * credential in a finding. This makes "no secret is ever printed" a property
 * of the program rather than of every future edit to it.
 */
export function scrubOrThrow(text, secrets) {
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8 && text.includes(secret)) {
      throw new Error('orientation output contained a credential value — refusing to print');
    }
  }
  return text;
}

/* -------------------------------------------------------------------- main */

export function parseArgs(argv) {
  const options = { json: false, check: false, probeModels: false, verifyAgents: false, initConfig: false, initConfigPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--probe-models') options.probeModels = true;
    else if (arg === '--verify-agents') options.verifyAgents = true;
    else if (arg === '--init-config') {
      options.initConfig = true;
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) { options.initConfigPath = next; index += 1; }
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else options.unknown = arg;
  }
  return options;
}

const USAGE = `Toros orientation — what this is, and whether it can run here.

  node tools/orient.mjs                 report environment, agents, config, and codebase map
  node tools/orient.mjs --json          the same findings, machine-readable
  node tools/orient.mjs --check         exit 1 if any finding is a blocker
  node tools/orient.mjs --init-config   write a starter config.json (never overwrites)
  node tools/orient.mjs --probe-models  additionally ask the configured provider for its model list
  node tools/orient.mjs --verify-agents drive each agent through one real exchange and report the outcome

Read-only unless --init-config. No network request unless --probe-models.
--verify-agents is the one flag that RUNS an agent: a fixed prompt, a pinned
read-only sandbox, a throwaway workspace, and a hard deadline.
Credential values are never printed, in any mode.`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(USAGE); return 0; }
  if (options.unknown) { console.error(`unknown argument: ${options.unknown}\n\n${USAGE}`); return 2; }

  const environment = collectEnvironment();
  const agents = collectAgents();
  const config = collectConfiguration();
  const map = collectMap();
  const caps = await collectCapabilities();
  const suites = await collectRealBinarySuites();

  const modelFindings = options.probeModels ? await probeModels(config.coordinator) : [];
  const initFindings = options.initConfig ? initConfig(options.initConfigPath) : [];

  // A configured executable is what a run would use; PATH discovery is the
  // fallback for a machine that has not been configured yet.
  const targets = new Map(agents.usableExecutables);
  for (const [id, executable] of config.configuredExecutables) targets.set(id, executable);
  const verifyFindings = options.verifyAgents ? await verifyAgents(targets, config.configuredSpecs) : [];

  const sections = [
    ['Environment', environment],
    ['Agents', agents.findings],
    ['Agent verification', verifyFindings],
    ['Configuration', [...config.findings, ...initFindings]],
    ['Models', modelFindings],
    ['Real-binary suites', suites],
    ['Codebase', [...map.findings, ...caps.findings]],
  ];

  const all = sections.flatMap(([, findings]) => findings);
  const blockers = all.filter((item) => item.level === BLOCK).length;
  const warnings = all.filter((item) => item.level === WARN).length;

  const payload = {
    findings: all,
    packages: map.packages,
    specs: map.specs,
    capabilities: caps.capabilities,
    summary: { blockers, warnings, ok: all.length - blockers - warnings },
  };

  const text = options.json
    ? JSON.stringify(payload, null, 2)
    : `${renderReport(sections, { packages: map.packages, specs: map.specs, capabilities: caps.capabilities })}\n\n${
      blockers === 0
        ? `No blockers. ${warnings} warning(s).`
        : `${blockers} blocker(s), ${warnings} warning(s). Each BLOCK line above names its fix.`}\n`;

  console.log(scrubOrThrow(text, config.secrets));
  return options.check && blockers > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
