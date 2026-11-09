/**
 * Offline unit tests for the AU0a vision grounding bakeoff harness.
 *
 * Runs with `node --test tools/vision-bakeoff/test/` — requires no network
 * access and no Windows desktop session, with zero skipped tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_PS1_PATH,
  parseJsonNoBom,
  validateMetaData,
  validateTreeData,
} from '../capture.mjs';
import {
  assertApiKeysPresent,
  buildGrounderTable,
  loadGroundersConfig,
  parseGenericJsonOutput,
  parseUiTarsOutput,
  scrubSecrets,
  verifyModelsInCatalog,
} from '../grounders.mjs';
import {
  computeSummary,
  renderMarkdownReport,
} from '../report.mjs';
import { runBakeoff } from '../run.mjs';
import {
  findDeepestElementAtPoint,
  pixelToScreenPoint,
  scoreResponse,
} from '../score.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BAKEOFF_DIR = path.resolve(THIS_DIR, '..');

describe('1. UI-TARS output parser', () => {
  it("parses Action: click(start_box='(500,250)') and scales 0-1000 coords to image pixels", () => {
    const res = parseUiTarsOutput(
      "Thought: That is the 7 key.\nAction: click(start_box='(500,250)')",
      { width: 800, height: 600 },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 'point');
    assert.deepEqual(res.point, { x: 400, y: 150 });
  });

  it('parses <point>500 250</point> and scales 0-1000 coords to image pixels', () => {
    const res = parseUiTarsOutput(
      'Thought: Clicking equals\nAction: click(point=\'<point>500 250</point>\')',
      { width: 1200, height: 800 },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 'point');
    assert.deepEqual(res.point, { x: 600, y: 200 });
  });

  it('parses 4-tuple start_box bounding box by taking the center point', () => {
    const res = parseUiTarsOutput(
      "Action: click(start_box='(200,100,400,300)')",
      { width: 1000, height: 500 },
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.point, { x: 300, y: 100 });
  });

  it('returns parse_error on malformed or out-of-range UI-TARS output', () => {
    for (const bad of [
      '',
      'Thought: I cannot find the button.',
      "Action: type(content='hello')",
      "Action: click(start_box='(1500, 250)')",
      '<point>abc def</point>',
    ]) {
      const res = parseUiTarsOutput(bad, { width: 800, height: 600 });
      assert.equal(res.ok, false, `Expected parse failure for: ${bad}`);
      assert.equal(res.status, 'parse_error');
    }
  });
});

describe('2. Generic strict JSON parser', () => {
  it('parses valid {"x": <int>, "y": <int>} pixel coordinates', () => {
    const res = parseGenericJsonOutput('{"x": 312, "y": 445}');
    assert.equal(res.ok, true);
    assert.equal(res.status, 'point');
    assert.deepEqual(res.point, { x: 312, y: 445 });
  });

  it('parses {"not_found": true} as not_found', () => {
    const res = parseGenericJsonOutput('{"not_found": true}');
    assert.equal(res.ok, true);
    assert.equal(res.status, 'not_found');
    assert.equal(res.not_found, true);
    assert.equal(res.point, null);
  });

  it('returns parse_error on garbage or invalid JSON structures', () => {
    for (const garbage of [
      '',
      'not json at all',
      '{"x": "100", "y": 200}',
      '{"x": -5, "y": 10}',
      '{"x": 10}',
      '[]',
      '{"not_found": false}',
    ]) {
      const res = parseGenericJsonOutput(garbage);
      assert.equal(res.ok, false, `Expected parse_error for: ${garbage}`);
      assert.equal(res.status, 'parse_error');
    }
  });
});

describe('3. Scoring on a synthetic tree.json', () => {
  const syntheticMeta = {
    dpi: 96,
    window_rect: {
      left: 100,
      top: 100,
      right: 500,
      bottom: 500,
      width: 400,
      height: 400,
    },
    image_size: {
      width: 400,
      height: 400,
    },
  };

  const winStep = {
    control_type: 'Window',
    automation_id: null,
    name: 'Calculator',
    index: 0,
  };
  const paneStep = {
    control_type: 'Pane',
    automation_id: 'MainPane',
    name: null,
    index: 0,
  };
  const groupStep = {
    control_type: 'Group',
    automation_id: 'NumberPad',
    name: 'Number pad',
    index: 0,
  };
  const btn7Step = {
    control_type: 'Button',
    automation_id: 'num7Button',
    name: 'Seven',
    index: 0,
  };
  const btn8Step = {
    control_type: 'Button',
    automation_id: 'num8Button',
    name: 'Eight',
    index: 0,
  };
  const disabledBtnStep = {
    control_type: 'Button',
    automation_id: 'memClearButton',
    name: 'Clear all memory',
    index: 0,
  };
  const offscreenBtnStep = {
    control_type: 'Button',
    automation_id: 'offscreenOverlayBtn',
    name: 'Hidden Overlay',
    index: 0,
  };

  const syntheticTree = [
    {
      control_type: 'Window',
      automation_id: null,
      name: 'Calculator',
      bounding_rect: { left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400 },
      enabled: true,
      is_offscreen: false,
      selector: [winStep],
    },
    {
      control_type: 'Pane',
      automation_id: 'MainPane',
      name: null,
      bounding_rect: { left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400 },
      enabled: true,
      is_offscreen: false,
      selector: [winStep, paneStep],
    },
    {
      control_type: 'Group',
      automation_id: 'NumberPad',
      name: 'Number pad',
      bounding_rect: { left: 120, top: 200, right: 480, bottom: 480, width: 360, height: 280 },
      enabled: true,
      is_offscreen: false,
      selector: [winStep, paneStep, groupStep],
    },
    {
      control_type: 'Button',
      automation_id: 'num7Button',
      name: 'Seven',
      bounding_rect: { left: 150, top: 250, right: 230, bottom: 310, width: 80, height: 60 },
      enabled: true,
      is_offscreen: false,
      selector: [winStep, paneStep, groupStep, btn7Step],
    },
    {
      control_type: 'Button',
      automation_id: 'num8Button',
      name: 'Eight',
      bounding_rect: { left: 240, top: 250, right: 320, bottom: 310, width: 80, height: 60 },
      enabled: true,
      is_offscreen: false,
      selector: [winStep, paneStep, groupStep, btn8Step],
    },
    {
      control_type: 'Button',
      automation_id: 'memClearButton',
      name: 'Clear all memory',
      bounding_rect: { left: 330, top: 250, right: 410, bottom: 310, width: 80, height: 60 },
      enabled: false,
      is_offscreen: false,
      selector: [winStep, paneStep, groupStep, disabledBtnStep],
    },
    {
      // Offscreen element with a deeper selector covering num7Button: must be ignored
      control_type: 'Button',
      automation_id: 'offscreenOverlayBtn',
      name: 'Hidden Overlay',
      bounding_rect: { left: 150, top: 250, right: 230, bottom: 310, width: 80, height: 60 },
      enabled: true,
      is_offscreen: true,
      selector: [winStep, paneStep, groupStep, btn7Step, offscreenBtnStep],
    },
  ];

  const expectedBtn7 = [winStep, paneStep, groupStep, btn7Step];

  it('classifies a hit when the deepest on-screen element equals expected (deepest wins over parent, offscreen ignored)', () => {
    // Image pixel (80, 180) -> screen point (180, 280), inside num7Button [150..230, 250..310]
    const result = scoreResponse({
      parsed: { ok: true, status: 'point', point: { x: 80, y: 180 } },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(result.classification, 'hit');
    assert.deepEqual(result.screen_point, { x: 180, y: 280 });
    assert.equal(result.element.automation_id, 'num7Button');
  });

  it('classifies wrong_element when landing on an adjacent enabled actionable button', () => {
    // Image pixel (180, 180) -> screen point (280, 280), inside num8Button [240..320, 250..310]
    const result = scoreResponse({
      parsed: { ok: true, status: 'point', point: { x: 180, y: 180 } },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(result.classification, 'wrong_element');
    assert.equal(result.element.automation_id, 'num8Button');
  });

  it('classifies harmless_miss when landing on a non-actionable Pane or Group or disabled Button', () => {
    // Image pixel (20, 30) -> screen point (120, 130), inside MainPane only
    const paneRes = scoreResponse({
      parsed: { ok: true, status: 'point', point: { x: 20, y: 30 } },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(paneRes.classification, 'harmless_miss');
    assert.equal(paneRes.element.control_type, 'Pane');

    // Image pixel (270, 180) -> screen point (370, 280), inside disabled memClearButton
    const disabledRes = scoreResponse({
      parsed: { ok: true, status: 'point', point: { x: 270, y: 180 } },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(disabledRes.classification, 'harmless_miss');
    assert.equal(disabledRes.element.automation_id, 'memClearButton');
  });

  it('classifies outside-window coordinates and explicit model refusals as not_found', () => {
    const outsideRes = scoreResponse({
      parsed: { ok: true, status: 'point', point: { x: 450, y: 180 } },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(outsideRes.classification, 'not_found');

    const declinedRes = scoreResponse({
      parsed: { ok: true, status: 'not_found', not_found: true, point: null },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(declinedRes.classification, 'not_found');
  });

  it('deepest element wins over its parent container in findDeepestElementAtPoint', () => {
    const hit = findDeepestElementAtPoint(syntheticTree, { x: 180, y: 280 });
    assert.ok(hit);
    assert.equal(hit.automation_id, 'num7Button');
    assert.equal(hit.selector.length, 4);
  });
});

describe('4. DPI / window_rect coordinate mapping', () => {
  it('maps image pixels in a 150% DPI window (144 DPI) to the right physical screen point', () => {
    // Case A: logical 400x300 image on a 150% DPI (144 DPI) window with 600x450 physical rect
    const metaWithLogicalImage = {
      dpi: 144,
      window_rect: {
        left: 200,
        top: 100,
        right: 800,
        bottom: 550,
        width: 600,
        height: 450,
      },
      image_size: {
        width: 400,
        height: 300,
      },
    };
    const ptA = pixelToScreenPoint({ x: 100, y: 80 }, metaWithLogicalImage);
    assert.deepEqual(ptA, { x: 200 + 150, y: 100 + 120 });

    // Case B: 144 DPI metadata without explicit image_size scales by dpi / 96 = 1.5
    const metaDpiOnly = {
      dpi: 144,
      window_rect: {
        left: 200,
        top: 100,
        width: 600,
        height: 450,
      },
    };
    const ptB = pixelToScreenPoint({ x: 100, y: 80 }, metaDpiOnly);
    assert.deepEqual(ptB, { x: 350, y: 220 });
  });
});

describe('5. OpenRouter model-id catalog check', () => {
  const fixtureCatalog = {
    data: [
      {
        id: 'bytedance/ui-tars-1.5-7b',
        pricing: { prompt: '0.0000001', completion: '0.0000002' },
      },
      {
        id: 'anthropic/claude-sonnet-4',
        pricing: { prompt: '0.000003', completion: '0.000015' },
      },
      {
        id: 'qwen/qwen2.5-vl-72b-instruct',
        pricing: { prompt: '0.0000004', completion: '0.0000004' },
      },
    ],
  };

  it('accepts grounders whose model IDs are present in the OpenRouter catalog fixture', () => {
    const check = verifyModelsInCatalog(
      [
        { id: 'ui-tars-1.5-7b', model: 'bytedance/ui-tars-1.5-7b' },
        { id: 'claude', model: 'anthropic/claude-sonnet-4' },
      ],
      fixtureCatalog,
    );
    assert.equal(check.ids.has('bytedance/ui-tars-1.5-7b'), true);
    assert.equal(check.pricingByModel.get('anthropic/claude-sonnet-4').prompt, 0.000003);
  });

  it('refuses a model ID that is absent from the OpenRouter catalog fixture', () => {
    assert.throws(
      () =>
        verifyModelsInCatalog(
          [
            { id: 'ui-tars-1.5-7b', model: 'bytedance/ui-tars-1.5-7b' },
            { id: 'qwen', model: 'qwen/nonexistent-qwen3-vl-999b' },
          ],
          fixtureCatalog,
        ),
      (err) => {
        assert.equal(err.code, 'E_MODEL_NOT_LISTED');
        assert.match(err.message, /qwen\/nonexistent-qwen3-vl-999b/);
        return true;
      },
    );
  });
});

describe('6. Report formatting and rate computation', () => {
  const sampleRecords = [
    {
      grounder: 'ui-tars-1.5-7b',
      model: 'bytedance/ui-tars-1.5-7b',
      app: 'calculator',
      target_id: 't1',
      hard: false,
      classification: 'hit',
      latency_ms: 400,
      usage: { prompt_tokens: 1000, completion_tokens: 20 },
    },
    {
      grounder: 'ui-tars-1.5-7b',
      model: 'bytedance/ui-tars-1.5-7b',
      app: 'calculator',
      target_id: 't2',
      hard: true,
      classification: 'wrong_element',
      latency_ms: 500,
      usage: { prompt_tokens: 1000, completion_tokens: 20 },
    },
    {
      grounder: 'ui-tars-1.5-7b',
      model: 'bytedance/ui-tars-1.5-7b',
      app: 'calculator',
      target_id: 't3',
      hard: true,
      classification: 'harmless_miss',
      latency_ms: 600,
      usage: { prompt_tokens: 1000, completion_tokens: 20 },
    },
    {
      grounder: 'ui-tars-1.5-7b',
      model: 'bytedance/ui-tars-1.5-7b',
      app: 'calculator',
      target_id: 't4',
      hard: false,
      classification: 'not_found',
      latency_ms: 700,
      usage: { prompt_tokens: 1000, completion_tokens: 20 },
    },
    {
      grounder: 'ui-tars-1.5-7b',
      model: 'bytedance/ui-tars-1.5-7b',
      app: 'calculator',
      target_id: 't5',
      hard: false,
      classification: 'parse_error',
      latency_ms: 900,
      usage: { prompt_tokens: 1000, completion_tokens: 20 },
    },
  ];

  const pricing = new Map([
    ['bytedance/ui-tars-1.5-7b', { prompt: 0.000001, completion: 0.000002, image: 0, request: 0 }],
  ]);

  it('places wrong_element as the first metric column (bold) and computes rates, hard split, latency, and cost accurately', () => {
    const summary = computeSummary(sampleRecords, pricing);
    assert.equal(summary.metric_order[0], 'wrong_element');
    assert.equal(summary.by_grounder_app.length, 1);

    const row = summary.by_grounder_app[0];
    assert.equal(row.total, 5);
    assert.equal(row.counts.wrong_element, 1);
    assert.equal(row.counts.hit, 1);
    assert.equal(row.counts.harmless_miss, 1);
    assert.equal(row.counts.not_found, 1);
    assert.equal(row.counts.parse_error, 1);
    assert.equal(row.rates.wrong_element, 0.2);
    assert.equal(row.rates.hit, 0.2);

    // Hard split: 2 hard targets (1 wrong_element, 1 harmless_miss)
    assert.equal(row.hard.total, 2);
    assert.equal(row.hard.counts.wrong_element, 1);
    assert.equal(row.hard.rates.wrong_element, 0.5);
    assert.equal(row.hard.counts.harmless_miss, 1);
    assert.equal(row.hard.rates.harmless_miss, 0.5);

    // Latency p50 & p95
    assert.equal(row.latency_ms.p50, 600);
    assert.equal(row.latency_ms.p95, 900);

    // Cost per call = 1000 * 1e-6 + 20 * 2e-6 = 0.00104 USD -> per 100 calls = 0.104 USD
    assert.equal(row.cost_per_100_usd, 0.104);

    const md = renderMarkdownReport(summary);
    const headerLine = md
      .split('\n')
      .find((line) => line.startsWith('| Grounder | App |'));
    assert.ok(headerLine, 'Expected Grounder x App Markdown table header');
    const cols = headerLine
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    // Columns: Grounder, App, **wrong_element**, hit, harmless_miss, not_found, parse_error, ...
    assert.equal(cols[0], 'Grounder');
    assert.equal(cols[1], 'App');
    assert.equal(cols[2], '**wrong_element**');
    assert.equal(cols[3], 'hit');
  });
});

describe('7. Pre-flight safety, secret scrubbing, and fixture/target invariants', () => {
  it('runBakeoff fails fast naming OPENROUTER_API_KEY before any capture or network call when key is missing', async () => {
    let captureCalled = false;
    let fetchCalled = false;

    await assert.rejects(
      () =>
        runBakeoff({
          apps: ['calculator'],
          grounderIds: ['ui-tars-1.5-7b'],
          env: {},
          captureFn: async () => {
            captureCalled = true;
          },
          fetchFn: async () => {
            fetchCalled = true;
            throw new Error('fetch should not be called');
          },
        }),
      (err) => {
        assert.equal(err.code, 'E_MISSING_API_KEY');
        assert.match(err.message, /OPENROUTER_API_KEY/);
        return true;
      },
    );

    assert.equal(captureCalled, false, 'captureFn must not be called when API key is missing');
    assert.equal(fetchCalled, false, 'fetchFn must not be called when API key is missing');
  });

  it('scrubSecrets removes API keys and Authorization headers from error messages', () => {
    const secret = 'sk-or-v1-supersecretkeyvalue123456';
    const raw = `Request failed with Authorization: Bearer ${secret} and key=${secret}`;
    const cleaned = scrubSecrets(raw, [secret]);
    assert.equal(cleaned.includes(secret), false);
    assert.match(cleaned, /\[REDACTED\]/);
  });

  it('targets/calculator.json and targets/notepad.json each contain 50 valid targets with hard subset', () => {
    for (const app of ['calculator', 'notepad']) {
      const targetPath = path.join(BAKEOFF_DIR, 'targets', `${app}.json`);
      const targets = parseJsonNoBom(readFileSync(targetPath, 'utf8'));
      assert.equal(Array.isArray(targets), true);
      assert.equal(targets.length, 50, `Expected 50 targets in ${app}.json, got ${targets.length}`);

      const ids = new Set();
      let hardCount = 0;
      for (const t of targets) {
        assert.equal(typeof t.id, 'string');
        assert.ok(t.id.length > 0);
        assert.equal(ids.has(t.id), false, `Duplicate target id ${t.id} in ${app}.json`);
        ids.add(t.id);
        assert.equal(typeof t.description, 'string');
        assert.ok(t.description.length > 0);
        assert.equal(Array.isArray(t.expected), true);
        assert.ok(t.expected.length >= 2);
        if (t.hard === true) hardCount += 1;
      }
      assert.ok(hardCount >= 8 && hardCount <= 15, `Expected ~10 hard targets in ${app}.json, got ${hardCount}`);
    }
  });

  it('capture.ps1 follows fixed-script + JSON-params discipline', () => {
    const ps1 = readFileSync(CAPTURE_PS1_PATH, 'utf8');
    assert.match(ps1, /\[string\]\$ParamsFile/);
    assert.match(ps1, /PrintWindow/);
    assert.match(ps1, /PW_RENDERFULLCONTENT/);
    assert.match(ps1, /GetDpiForWindow/);
    assert.match(ps1, /ControlViewWalker/);
    assert.equal(ps1.includes('Invoke-Expression'), false);
  });

  it('grounders.config.json provides non-hardcoded model IDs for claude and qwen', () => {
    const cfg = loadGroundersConfig();
    const table = buildGrounderTable(cfg);
    assert.equal(table['ui-tars-1.5-7b'].model, 'bytedance/ui-tars-1.5-7b');
    assert.equal(table.claude.model, cfg.models.claude);
    assert.equal(table.qwen.model, cfg.models.qwen);
    assert.equal(table.local.optional, true);
    assert.throws(
      () => assertApiKeysPresent([table['ui-tars-1.5-7b']], {}),
      /OPENROUTER_API_KEY/,
    );
  });

  it('validateTreeData and validateMetaData accept valid payloads and strip UTF-8 BOM', () => {
    const rawWithBom = '\uFEFF' + JSON.stringify({
      dpi: 144,
      window_rect: { left: 0, top: 0, width: 600, height: 400 },
    });
    const meta = validateMetaData(parseJsonNoBom(rawWithBom));
    assert.equal(meta.dpi, 144);

    const tree = validateTreeData([
      {
        control_type: 'Window',
        automation_id: null,
        name: 'Notepad',
        enabled: true,
        is_offscreen: false,
        bounding_rect: { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 },
        selector: [{ control_type: 'Window', automation_id: null, name: 'Notepad', index: 0 }],
      },
    ]);
    assert.equal(tree.length, 1);
  });
});
