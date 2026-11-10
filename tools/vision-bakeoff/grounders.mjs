/**
 * Grounder definitions, prompts, parsers, OpenRouter catalog verification,
 * and OpenAI-compatible vision chat client — Toros slice AU0a.
 *
 * Uses Node built-in `fetch` only. Model outputs are treated as untrusted data:
 * free text ("Thought: ...") is discarded at the parser so only coordinates survive.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(THIS_DIR, 'grounders.config.json');
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const UTF8_BOM_RE = /^\uFEFF/;

function parseJsonNoBom(text) {
  return JSON.parse(UTF8_BOM_RE.test(text) ? text.replace(UTF8_BOM_RE, '') : text);
}

/**
 * Scrub API keys and Authorization/Bearer tokens from any string before it
 * enters a log, file, or error message.
 */
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  out = out.replace(/Authorization\s*:\s*Bearer\s+[^\s"',;}\]]+/gi, 'Authorization: Bearer [REDACTED]');
  out = out.replace(/Authorization\s*:\s*[^\s"',;}\]]+/gi, 'Authorization: [REDACTED]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-]{8,}/g, 'Bearer [REDACTED]');
  out = out.replace(/\bsk-or-v1-[A-Za-z0-9._\-]+/g, '[REDACTED]');
  return out;
}

/** Normalize image dimensions from either ({ width, height }) or (width, height). */
function resolveImageSize(sizeOrWidth, maybeHeight) {
  if (typeof sizeOrWidth === 'number' && typeof maybeHeight === 'number') {
    return { width: sizeOrWidth, height: maybeHeight };
  }
  if (typeof sizeOrWidth === 'object' && sizeOrWidth !== null) {
    const width = Number(sizeOrWidth.width);
    const height = Number(sizeOrWidth.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

/** Python-style round-half-to-even, as used by Qwen2.5-VL's `smart_resize`. */
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Qwen2.5-VL `smart_resize` (UI-TARS-1.5 is built on it): the image the model actually sees is
 * rescaled so both sides are multiples of `factor` and the area lies within [minPixels, maxPixels].
 * UI-TARS-1.5 answers in absolute pixels of THAT resized image (UI-TARS README, coordinate
 * processing), not 0–1000 like UI-TARS v1.
 */
export function smartResize(width, height, { factor = 28, minPixels = 100 * 28 * 28, maxPixels = 16384 * 28 * 28 } = {}) {
  let hBar = Math.max(factor, roundHalfEven(height / factor) * factor);
  let wBar = Math.max(factor, roundHalfEven(width / factor) * factor);
  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    hBar = Math.max(factor, Math.floor(height / beta / factor) * factor);
    wBar = Math.max(factor, Math.floor(width / beta / factor) * factor);
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    hBar = Math.ceil((height * beta) / factor) * factor;
    wBar = Math.ceil((width * beta) / factor) * factor;
  }
  return { width: wBar, height: hBar };
}

/**
 * Map a model coordinate pair to image pixels.
 *   - `norm1000`: 0–1000 relative (UI-TARS v1, Qwen3-VL);
 *   - `smart_resize`: absolute pixels in the Qwen2.5-VL smart-resized image (UI-TARS-1.5);
 *   - `pixels`: already image pixels (generic prompt answered literally).
 * Returns null when the pair is outside the coordinate space.
 */
export function mapModelPoint(mx, my, imageSize, coordMode = 'pixels') {
  if (!Number.isFinite(mx) || !Number.isFinite(my) || mx < 0 || my < 0) return null;
  if (coordMode === 'norm1000') {
    if (mx > 1000 || my > 1000) return null;
    return { x: Math.round((mx / 1000) * imageSize.width), y: Math.round((my / 1000) * imageSize.height) };
  }
  if (coordMode === 'smart_resize') {
    const resized = smartResize(imageSize.width, imageSize.height);
    if (mx > resized.width || my > resized.height) return null;
    return { x: Math.round((mx / resized.width) * imageSize.width), y: Math.round((my / resized.height) * imageSize.height) };
  }
  return { x: Math.round(mx), y: Math.round(my) };
}

/**
 * Parse UI-TARS output into pixel coordinates in the given image size.
 *
 * Handles both:
 *   - `Action: click(start_box='(x,y)')` (or 4-tuple bounding box `(x1,y1,x2,y2)`)
 *   - `<point>x y</point>` (or `<point>x, y</point>`)
 * Coordinate convention per `opts.coordMode`: `norm1000` (UI-TARS v1, default for backward
 * compatibility) or `smart_resize` (UI-TARS-1.5).
 *
 * Free text is discarded; only the scaled pixel coordinates survive.
 */
export function parseUiTarsOutput(rawText, sizeOrWidth, maybeHeight, opts = {}) {
  const coordMode = opts.coordMode ?? 'norm1000';
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return { ok: false, status: 'parse_error', error: 'Empty or non-string UI-TARS response' };
  }

  let normX = null;
  let normY = null;

  // 1. Check click(start_box=...) — supports (x,y), <|box_start|>(x,y)<|box_end|>, or (x1,y1,x2,y2)
  const startBoxMatch = /start_box\s*=\s*['"](?:<\|box_start\|>)?\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)(?:\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?))?\s*\)(?:<\|box_end\|>)?['"]/i.exec(rawText);
  if (startBoxMatch) {
    const x1 = Number(startBoxMatch[1]);
    const y1 = Number(startBoxMatch[2]);
    if (startBoxMatch[3] !== undefined && startBoxMatch[4] !== undefined) {
      const x2 = Number(startBoxMatch[3]);
      const y2 = Number(startBoxMatch[4]);
      normX = (x1 + x2) / 2;
      normY = (y1 + y2) / 2;
    } else {
      normX = x1;
      normY = y1;
    }
  }

  // 2. Check <point>x y</point> or <point>(x, y)</point>
  if (normX === null || normY === null) {
    const pointMatch = /<point>\s*\(?\s*([+-]?\d+(?:\.\d+)?)\s*(?:[\s,]+)\s*([+-]?\d+(?:\.\d+)?)\s*\)?\s*<\/point>/i.exec(rawText);
    if (pointMatch) {
      normX = Number(pointMatch[1]);
      normY = Number(pointMatch[2]);
    }
  }

  // 3. Explicit UI-TARS decline: finished(content='not_found') (and only this form) when no coordinates are present
  if (normX === null && normY === null) {
    const hasCoordinateAttempt = /start_box\s*=|<point>/i.test(rawText);
    const finishedNotFoundMatch = /\bfinished\s*\(\s*content\s*=\s*(['"])not_found\1\s*\)/.exec(rawText);
    if (!hasCoordinateAttempt && finishedNotFoundMatch) {
      return {
        ok: true,
        status: 'not_found',
        not_found: true,
        point: null,
      };
    }
    return { ok: false, status: 'parse_error', error: 'No valid UI-TARS coordinates found in response' };
  }

  if (normX === null || normY === null || !Number.isFinite(normX) || !Number.isFinite(normY)) {
    return { ok: false, status: 'parse_error', error: 'No valid UI-TARS coordinates found in response' };
  }

  const imageSize = resolveImageSize(sizeOrWidth, maybeHeight);
  if (!imageSize || imageSize.width <= 0 || imageSize.height <= 0) {
    return { ok: false, status: 'parse_error', error: 'Valid imageSize { width, height } is required for UI-TARS scaling' };
  }

  const mapped = mapModelPoint(normX, normY, imageSize, coordMode);
  if (!mapped) {
    return { ok: false, status: 'parse_error', error: `UI-TARS coordinates out of range for ${coordMode}: (${normX}, ${normY})` };
  }
  const { x, y } = mapped;

  return {
    ok: true,
    status: 'point',
    x,
    y,
    point: { x, y },
  };
}

/**
 * Parse generic strict JSON output:
 *   `{"x": <int>, "y": <int>}`, or `{"not_found": true}`.
 * Also accepts the pair shapes vision models actually emit: `{"point_2d": [x, y]}`,
 * `{"x": [x, y]}` (pair packed into "x"), and a bare `[x, y]`.
 * Coordinates are interpreted per `opts.coordMode` (`pixels` by default; `norm1000` for Qwen3-VL).
 */
export function parseGenericJsonOutput(rawText, sizeOrWidth, maybeHeight, opts = {}) {
  const coordMode = opts.coordMode ?? 'pixels';
  const imageSize = resolveImageSize(sizeOrWidth, maybeHeight);
  if (coordMode !== 'pixels' && !imageSize) {
    return { ok: false, status: 'parse_error', error: `Valid imageSize { width, height } is required for ${coordMode}` };
  }
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return { ok: false, status: 'parse_error', error: 'Empty or non-string JSON response' };
  }

  let candidate = rawText.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, status: 'parse_error', error: 'Response is not valid JSON' };
  }

  // Strict: coordinates must be JSON numbers. Quoted numbers count as a format failure (parse_error).
  const num = (n) => (typeof n === 'number' ? n : NaN);
  const asPair = (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(num(n))) ? [num(v[0]), num(v[1])] : null);
  let pair = null;
  if (asPair(parsed)) pair = asPair(parsed);
  else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    pair = asPair(parsed.point_2d) ?? asPair(parsed.point) ?? asPair(parsed.x);
    if (!pair && Number.isFinite(num(parsed.x)) && Number.isFinite(num(parsed.y))) pair = [num(parsed.x), num(parsed.y)];
  }
  if (pair && !(parsed && parsed.not_found === true)) {
    const mapped = coordMode === 'pixels' ? mapModelPoint(pair[0], pair[1], imageSize ?? { width: 1, height: 1 }, 'pixels') : mapModelPoint(pair[0], pair[1], imageSize, coordMode);
    if (!mapped) {
      return { ok: false, status: 'parse_error', error: `Coordinates out of range for ${coordMode}: (${pair[0]}, ${pair[1]})` };
    }
    return { ok: true, status: 'point', x: mapped.x, y: mapped.y, point: { x: mapped.x, y: mapped.y } };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 'parse_error', error: 'JSON response must be an object' };
  }

  if (parsed.not_found === true && parsed.x === undefined && parsed.y === undefined) {
    return {
      ok: true,
      status: 'not_found',
      not_found: true,
      point: null,
    };
  }

  if (
    typeof parsed.x === 'number' &&
    Number.isFinite(parsed.x) &&
    typeof parsed.y === 'number' &&
    Number.isFinite(parsed.y) &&
    parsed.x >= 0 &&
    parsed.y >= 0 &&
    !parsed.not_found
  ) {
    const x = Math.round(parsed.x);
    const y = Math.round(parsed.y);
    return {
      ok: true,
      status: 'point',
      x,
      y,
      point: { x, y },
    };
  }

  return { ok: false, status: 'parse_error', error: 'JSON object did not match {"x":<int>,"y":<int>} or {"not_found":true}' };
}

/** Build the prompt for a given prompt_style ('ui-tars' or 'generic'). */
export function buildGrounderPrompt(promptStyle, description, imageSize) {
  if (promptStyle === 'ui-tars') {
    return [
      'You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.',
      '',
      '## Output Format',
      '```',
      'Action: ...',
      '```',
      '',
      '## Action Space',
      "click(start_box='<|box_start|>(x1,y1)<|box_end|>')",
      "finished(content='not_found')",
      '',
      '## User Instruction',
      `Click on ${description}`,
    ].join('\n');
  }

  const sizeHint = imageSize && imageSize.width && imageSize.height
    ? ` (${imageSize.width}x${imageSize.height} pixels)`
    : '';
  return [
    `You are a UI grounding model. Look at the provided application window screenshot${sizeHint}.`,
    `Locate the control described as: ${JSON.stringify(description)}.`,
    'Return ONLY a strict JSON object with the pixel coordinates of the center of that control in the image:',
    '{"x": <int>, "y": <int>}',
    'If the described control is not visible in the window, return ONLY:',
    '{"not_found": true}',
    'Emit no prose, no markdown fences, and no extra keys.',
  ].join('\n');
}

/** Load grounders.config.json from disk. */
export function loadGroundersConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = readFileSync(configPath, 'utf8');
  const config = parseJsonNoBom(raw);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`Invalid grounders config at ${configPath}: expected JSON object`);
  }
  return config;
}

/**
 * Build the grounder table from grounders.config.json.
 * Model IDs for `claude` and `qwen` come from `grounders.config.json` (never hard-coded here).
 */
export function buildGrounderTable(config = loadGroundersConfig()) {
  const openrouterEndpoint = config.openrouter_endpoint ?? 'https://openrouter.ai/api/v1';
  const claudeModel = config?.models?.claude;
  const qwenModel = config?.models?.qwen;

  if (typeof claudeModel !== 'string' || claudeModel.trim().length === 0) {
    throw new Error('grounders.config.json is missing a non-empty models.claude string');
  }
  if (typeof qwenModel !== 'string' || qwenModel.trim().length === 0) {
    throw new Error('grounders.config.json is missing a non-empty models.qwen string');
  }

  const localCfg = config.local ?? {};
  const localPromptStyle = localCfg.prompt_style === 'generic' ? 'generic' : 'ui-tars';

  return {
    'ui-tars-1.5-7b': {
      id: 'ui-tars-1.5-7b',
      endpoint: openrouterEndpoint,
      model: 'bytedance/ui-tars-1.5-7b',
      key_env: 'OPENROUTER_API_KEY',
      prompt_style: 'ui-tars',
      coord_mode: 'smart_resize',
      parser: (raw, size) => parseUiTarsOutput(raw, size, undefined, { coordMode: 'smart_resize' }),
      optional: false,
    },
    claude: {
      id: 'claude',
      endpoint: openrouterEndpoint,
      model: claudeModel.trim(),
      key_env: 'OPENROUTER_API_KEY',
      prompt_style: 'generic',
      coord_mode: 'pixels',
      parser: parseGenericJsonOutput,
      optional: false,
    },
    qwen: {
      id: 'qwen',
      endpoint: openrouterEndpoint,
      model: qwenModel.trim(),
      key_env: 'OPENROUTER_API_KEY',
      prompt_style: 'generic',
      // Qwen3-VL grounds in 0–1000 relative coordinates regardless of the pixel prompt.
      coord_mode: 'norm1000',
      parser: (raw, size) => parseGenericJsonOutput(raw, size, undefined, { coordMode: 'norm1000' }),
      optional: false,
    },
    local: {
      id: 'local',
      endpoint: localCfg.endpoint ?? 'http://127.0.0.1:8080/v1',
      model: localCfg.model ?? 'local-model',
      key_env: localCfg.key_env ?? '',
      prompt_style: localPromptStyle,
      coord_mode: localCfg.coord_mode ?? (localPromptStyle === 'generic' ? 'pixels' : 'smart_resize'),
      parser: localPromptStyle === 'generic'
        ? (raw, size) => parseGenericJsonOutput(raw, size, undefined, { coordMode: localCfg.coord_mode ?? 'pixels' })
        : (raw, size) => parseUiTarsOutput(raw, size, undefined, { coordMode: localCfg.coord_mode ?? 'smart_resize' }),
      optional: true,
    },
  };
}

export const GROUNDERS = buildGrounderTable();

/**
 * Validate that every required API key environment variable is set and non-empty.
 * Fails fast naming the missing environment variable before any capture or network call.
 */
export function assertApiKeysPresent(grounders, env = process.env) {
  for (const g of grounders) {
    if (!g || g.optional) continue;
    const keyEnv = g.key_env;
    if (typeof keyEnv === 'string' && keyEnv.length > 0) {
      const val = env[keyEnv];
      if (typeof val !== 'string' || val.trim().length === 0) {
        const err = new Error(
          `Missing required API key environment variable "${keyEnv}" for grounder "${g.id}". Set ${keyEnv} in your environment before running.`,
        );
        err.code = 'E_MISSING_API_KEY';
        err.envVar = keyEnv;
        throw err;
      }
    }
  }
}

/**
 * Extract model IDs and pricing map from an OpenRouter `/api/v1/models` payload.
 */
export function parseModelsCatalog(catalogPayload) {
  const entries = Array.isArray(catalogPayload)
    ? catalogPayload
    : (Array.isArray(catalogPayload?.data) ? catalogPayload.data : []);
  const ids = new Set();
  const pricingByModel = new Map();

  for (const item of entries) {
    if (typeof item === 'string') {
      ids.add(item);
    } else if (typeof item === 'object' && item !== null && typeof item.id === 'string') {
      ids.add(item.id);
      if (typeof item.pricing === 'object' && item.pricing !== null) {
        pricingByModel.set(item.id, {
          prompt: Number(item.pricing.prompt ?? 0) || 0,
          completion: Number(item.pricing.completion ?? 0) || 0,
          image: Number(item.pricing.image ?? 0) || 0,
          request: Number(item.pricing.request ?? 0) || 0,
        });
      }
    }
  }

  return { ids, pricingByModel };
}

/**
 * Check that every configured model ID (or grounder entry) is listed in the
 * OpenRouter models catalog. Throws an Error with code 'E_MODEL_NOT_LISTED'
 * if any model is absent.
 */
export function verifyModelsInCatalog(groundersOrIds, catalogPayload) {
  const { ids, pricingByModel } = parseModelsCatalog(catalogPayload);
  const items = Array.isArray(groundersOrIds) ? groundersOrIds : [groundersOrIds];

  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'object' && item.optional === true) continue;
    const modelId = typeof item === 'string' ? item : item.model;
    const label = typeof item === 'object' && item.id ? ` (grounder "${item.id}")` : '';
    if (typeof modelId !== 'string' || modelId.length === 0 || !ids.has(modelId)) {
      const err = new Error(
        `Configured model "${modelId ?? ''}"${label} is not listed in https://openrouter.ai/api/v1/models; refusing to run.`,
      );
      err.code = 'E_MODEL_NOT_LISTED';
      err.model = modelId;
      throw err;
    }
  }

  return { ids, pricingByModel };
}

/**
 * Fetch https://openrouter.ai/api/v1/models and verify that every non-local
 * grounder's model ID is listed.
 */
export async function checkOpenRouterModels(grounders, {
  fetchFn = globalThis.fetch,
  modelsUrl = OPENROUTER_MODELS_URL,
  apiKey = process.env.OPENROUTER_API_KEY,
  timeoutMs = 15_000,
} = {}) {
  const headers = { accept: 'application/json' };
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let response;
  try {
    response = await fetchFn(modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(scrubSecrets(`Failed to reach OpenRouter models endpoint (${modelsUrl}): ${err?.message ?? err}`, [apiKey]));
  }
  if (!response.ok) {
    throw new Error(`OpenRouter models endpoint returned HTTP ${response.status}`);
  }
  const catalog = await response.json();
  return verifyModelsInCatalog(grounders, catalog);
}

/**
 * Probe whether the optional `local` grounder endpoint is reachable.
 */
export async function isLocalGrounderReachable(grounder, { fetchFn = globalThis.fetch, timeoutMs = 3_000 } = {}) {
  const base = grounder.endpoint.endsWith('/') ? grounder.endpoint.slice(0, -1) : grounder.endpoint;
  try {
    const res = await fetchFn(`${base}/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Call one OpenAI-compatible vision chat completion endpoint for a single target.
 */
export async function callGrounder({
  grounder,
  imageBase64,
  imageSize,
  description,
  env = process.env,
  fetchFn = globalThis.fetch,
  deadlineMs = 60_000,
}) {
  const apiKey = grounder.key_env ? (env[grounder.key_env] ?? '') : '';
  if (grounder.key_env && !grounder.optional && (!apiKey || apiKey.trim().length === 0)) {
    const err = new Error(`Missing required API key environment variable "${grounder.key_env}" for grounder "${grounder.id}"`);
    err.code = 'E_MISSING_API_KEY';
    throw err;
  }

  const promptText = buildGrounderPrompt(grounder.prompt_style, description, imageSize);
  const baseUrl = grounder.endpoint.endsWith('/') ? grounder.endpoint.slice(0, -1) : grounder.endpoint;
  const url = `${baseUrl}/chat/completions`;

  const headers = {
    'content-type': 'application/json',
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const body = {
    model: grounder.model,
    temperature: 0,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageBase64}`,
            },
          },
          {
            type: 'text',
            text: promptText,
          },
        ],
      },
    ],
  };

  const startedAt = performance.now();
  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deadlineMs),
    });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const safeMsg = scrubSecrets(err?.message ?? String(err), [apiKey]);
    const wrapped = new Error(`Grounder "${grounder.id}" request failed after ${latencyMs}ms: ${safeMsg}`);
    wrapped.code = 'E_TRANSPORT_ERROR';
    wrapped.latency_ms = latencyMs;
    throw wrapped;
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const safeDetail = scrubSecrets(errText.slice(0, 300), [apiKey]);
    const wrapped = new Error(`Grounder "${grounder.id}" HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`);
    wrapped.code = 'E_TRANSPORT_ERROR';
    wrapped.status = response.status;
    wrapped.latency_ms = latencyMs;
    throw wrapped;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    const safeMsg = scrubSecrets(err?.message ?? String(err), [apiKey]);
    const wrapped = new Error(`Grounder "${grounder.id}" invalid HTTP JSON body: ${safeMsg}`);
    wrapped.code = 'E_TRANSPORT_ERROR';
    wrapped.latency_ms = latencyMs;
    throw wrapped;
  }
  const rawContent = payload?.choices?.[0]?.message?.content;
  const rawReply = typeof rawContent === 'string'
    ? scrubSecrets(rawContent, [apiKey])
    : scrubSecrets(JSON.stringify(rawContent ?? ''), [apiKey]);

  const usage = payload?.usage
    ? {
        prompt_tokens: Number(payload.usage.prompt_tokens ?? 0) || 0,
        completion_tokens: Number(payload.usage.completion_tokens ?? 0) || 0,
        total_tokens: Number(payload.usage.total_tokens ?? 0) || 0,
        ...(typeof payload.usage.cost === 'number' ? { cost: payload.usage.cost } : {}),
      }
    : null;

  const parsed = grounder.parser(rawReply, imageSize);

  return {
    raw_reply: rawReply,
    parsed,
    latency_ms: latencyMs,
    usage,
  };
}
