/**
 * Offline unit tests for the AU0a vision grounding bakeoff harness.
 *
 * Runs with `node --test tools/vision-bakeoff/test/` — requires no network
 * access and no Windows desktop session, with zero skipped tests.
 */
import assert from 'node:assert/strict';
import { findDeepestElementAtPoint as __findAt, scoreResponse as __score } from '../score.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
  buildGrounderPrompt,
  buildGrounderTable,
  callGrounder,
  loadGroundersConfig,
  mapModelPoint,
  parseGenericJsonOutput,
  parseUiTarsOutput,
  scrubSecrets,
  smartResize,
  verifyModelsInCatalog,
} from '../grounders.mjs';
import {
  computeSummary,
  renderMarkdownReport,
} from '../report.mjs';
import { rescoreBakeoffDir } from '../rescore.mjs';
import { main as runMain, parseRunArgs, runBakeoff } from '../run.mjs';
import {
  findDeepestElementAtPoint,
  matchesExpectedSelector,
  pixelToScreenPoint,
  rectContainsPoint,
  scoreResponse,
  selectorsEqual,
  targetExistsInTree,
} from '../score.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BAKEOFF_DIR = path.resolve(THIS_DIR, '..');

describe('1. UI-TARS output parser & smartResize coordinate conventions', () => {
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

  it('computes smartResize for 1402x1078 -> 1400x1064, >maxPixels, and <minPixels', () => {
    assert.deepEqual(smartResize(1402, 1078), { width: 1400, height: 1064 });

    const maxPixels = 16384 * 28 * 28;
    const minPixels = 100 * 28 * 28;

    const downscaled = smartResize(5000, 4000);
    assert.equal(downscaled.width % 28, 0);
    assert.equal(downscaled.height % 28, 0);
    assert.ok(
      downscaled.width * downscaled.height <= maxPixels,
      `Expected area <= ${maxPixels}, got ${downscaled.width * downscaled.height}`,
    );

    const upscaled = smartResize(100, 100);
    assert.equal(upscaled.width % 28, 0);
    assert.equal(upscaled.height % 28, 0);
    assert.ok(
      upscaled.width * upscaled.height >= minPixels,
      `Expected area >= ${minPixels}, got ${upscaled.width * upscaled.height}`,
    );
    assert.deepEqual(upscaled, { width: 280, height: 280 });
  });

  it('maps UI-TARS-1.5 smart_resize (351,996) on 1402x1078 into num0Button in fixtures/calculator/tree.json', () => {
    const calcTree = parseJsonNoBom(
      readFileSync(path.join(BAKEOFF_DIR, 'fixtures', 'calculator', 'tree.json'), 'utf8'),
    );
    const calcMeta = parseJsonNoBom(
      readFileSync(path.join(BAKEOFF_DIR, 'fixtures', 'calculator', 'meta.json'), 'utf8'),
    );
    const calcTargets = parseJsonNoBom(
      readFileSync(path.join(BAKEOFF_DIR, 'targets', 'calculator.json'), 'utf8'),
    );
    const num0Target = calcTargets.find((t) => t.id === 'calc-01');
    assert.ok(num0Target);

    const parsed = parseUiTarsOutput(
      "Thought: Click zero.\nAction: click(start_box='(351,996)')",
      calcMeta.image_size,
      undefined,
      { coordMode: 'smart_resize' },
    );
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.point, { x: 352, y: 1009 });

    const scored = scoreResponse({
      parsed,
      tree: calcTree,
      expected: num0Target.expected,
      meta: calcMeta,
    });
    // The committed fixture's window sits at (2042, 672) on a 150% display; the mapped point must
    // land inside num0Button's own screen rect, whatever that rect is in the current fixture.
    const num0 = (Array.isArray(calcTree) ? calcTree : calcTree.elements).find((el) => el.automation_id === 'num0Button');
    assert.ok(num0, 'fixture has num0Button');
    const r0 = num0.bounding_rect;
    assert.ok(scored.screen_point.x >= r0.left && scored.screen_point.x < r0.right, `x ${scored.screen_point.x} inside [${r0.left}, ${r0.right})`);
    assert.ok(scored.screen_point.y >= r0.top && scored.screen_point.y < r0.bottom, `y ${scored.screen_point.y} inside [${r0.top}, ${r0.bottom})`);
    assert.equal(scored.classification, 'hit');
    assert.equal(scored.element.automation_id, 'num0Button');
  });

  it("includes finished(content='not_found') in UI-TARS prompt and maps only that decline action to not_found", () => {
    const prompt = buildGrounderPrompt('ui-tars', 'the Save button');
    assert.match(prompt, /finished\(content='not_found'\)/);

    const singleQuoteDecline = parseUiTarsOutput(
      "Thought: The control is not visible.\nAction: finished(content='not_found')",
      { width: 800, height: 600 },
      undefined,
      { coordMode: 'smart_resize' },
    );
    assert.equal(singleQuoteDecline.ok, true);
    assert.equal(singleQuoteDecline.status, 'not_found');
    assert.equal(singleQuoteDecline.not_found, true);
    assert.equal(singleQuoteDecline.point, null);

    const doubleQuoteDecline = parseUiTarsOutput(
      'Thought: Not present.\nAction: finished(content="not_found")',
      { width: 800, height: 600 },
    );
    assert.equal(doubleQuoteDecline.ok, true);
    assert.equal(doubleQuoteDecline.status, 'not_found');

    // Other finished() contents or free text without coordinates remain parse_error
    for (const nonDecline of [
      "Thought: Done.\nAction: finished(content='task_complete')",
      'Thought: not_found in free text only',
      "Action: click(start_box='(1500, 250)')\nAction: finished(content='not_found')",
    ]) {
      const res = parseUiTarsOutput(nonDecline, { width: 800, height: 600 });
      assert.equal(res.ok, false, `Expected parse_error for: ${nonDecline}`);
      assert.equal(res.status, 'parse_error');
    }
  });

  it('returns parse_error on malformed or out-of-range UI-TARS output across coordModes', () => {
    for (const bad of [
      '',
      'Thought: I cannot find the button.',
      "Action: type(content='hello')",
      "Action: click(start_box='(1500, 250)')",
      "Action: click(start_box='(-10, 250)')",
      '<point>abc def</point>',
    ]) {
      const res = parseUiTarsOutput(bad, { width: 800, height: 600 });
      assert.equal(res.ok, false, `Expected parse failure for: ${bad}`);
      assert.equal(res.status, 'parse_error');
    }

    // Out of range for smart_resize (1402x1078 -> 1400x1064)
    const outSmartX = parseUiTarsOutput(
      "Action: click(start_box='(1401, 500)')",
      { width: 1402, height: 1078 },
      undefined,
      { coordMode: 'smart_resize' },
    );
    assert.equal(outSmartX.ok, false);
    assert.equal(outSmartX.status, 'parse_error');

    const outSmartY = parseUiTarsOutput(
      "Action: click(start_box='(500, 1065)')",
      { width: 1402, height: 1078 },
      undefined,
      { coordMode: 'smart_resize' },
    );
    assert.equal(outSmartY.ok, false);
    assert.equal(outSmartY.status, 'parse_error');
  });
});

describe('2. Generic strict JSON parser & Qwen packed-pair norm1000 formats', () => {
  it('parses valid {"x": <int>, "y": <int>} pixel coordinates', () => {
    const res = parseGenericJsonOutput('{"x": 312, "y": 445}');
    assert.equal(res.ok, true);
    assert.equal(res.status, 'point');
    assert.deepEqual(res.point, { x: 312, y: 445 });
  });

  it('parses Qwen packed-pair shapes with coordMode: norm1000', () => {
    const imgSize = { width: 1402, height: 1078 };
    const expectedPoint = {
      x: Math.round((248 / 1000) * 1402),
      y: Math.round((933 / 1000) * 1078),
    };

    for (const payload of [
      '{"x":[248,933],"y":[933]}',
      '{"point_2d":[248,933]}',
      '[248,933]',
      '{"point":[248,933]}',
      '{"x":248,"y":933}',
    ]) {
      const res = parseGenericJsonOutput(payload, imgSize, undefined, { coordMode: 'norm1000' });
      assert.equal(res.ok, true, `Expected ok for payload: ${payload}`);
      assert.equal(res.status, 'point');
      assert.deepEqual(res.point, expectedPoint);
    }
  });

  it('parses {"not_found": true} as not_found', () => {
    const res = parseGenericJsonOutput('{"not_found": true}', { width: 800, height: 600 }, undefined, {
      coordMode: 'norm1000',
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'not_found');
    assert.equal(res.not_found, true);
    assert.equal(res.point, null);
  });

  it('returns parse_error on garbage, invalid JSON, or out-of-range coordinates', () => {
    for (const garbage of [
      '',
      'not json at all',
      '{"x": -5, "y": 10}',
      '{"x": 10}',
      '[]',
      '{"not_found": false}',
    ]) {
      const res = parseGenericJsonOutput(garbage);
      assert.equal(res.ok, false, `Expected parse_error for: ${garbage}`);
      assert.equal(res.status, 'parse_error');
    }

    // Out-of-range in norm1000 (>1000 or <0)
    for (const outOfRange of ['{"x": 1001, "y": 500}', '{"point_2d": [500, 1200]}', '[-1, 500]']) {
      const res = parseGenericJsonOutput(
        outOfRange,
        { width: 1000, height: 1000 },
        undefined,
        { coordMode: 'norm1000' },
      );
      assert.equal(res.ok, false, `Expected norm1000 range error for: ${outOfRange}`);
      assert.equal(res.status, 'parse_error');
    }

    assert.equal(mapModelPoint(1001, 500, { width: 800, height: 600 }, 'norm1000'), null);
    assert.equal(mapModelPoint(-1, 100, { width: 800, height: 600 }, 'pixels'), null);
  });
});

describe('3. Scoring, half-open hit-testing, leaf fallback, and invalid_target / transport_error', () => {
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
      bounding_rect: { left: 230, top: 250, right: 320, bottom: 310, width: 90, height: 60 },
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

  it('uses half-open hit-testing [left, right) x [top, bottom) on edge pixels', () => {
    const rect = { left: 150, top: 250, right: 230, bottom: 310 };
    assert.equal(rectContainsPoint(rect, { x: 150, y: 250 }), true);
    assert.equal(rectContainsPoint(rect, { x: 229, y: 309 }), true);
    assert.equal(rectContainsPoint(rect, { x: 230, y: 280 }), false);
    assert.equal(rectContainsPoint(rect, { x: 180, y: 310 }), false);

    // Boundary x=230 between num7Button [150..230) and num8Button [230..320) belongs strictly to num8Button
    const boundaryHit = findDeepestElementAtPoint(syntheticTree, { x: 230, y: 280 });
    assert.equal(boundaryHit.automation_id, 'num8Button');
  });

  it('classifies wrong_element when landing on an adjacent enabled actionable button', () => {
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
    const paneRes = scoreResponse({
      parsed: { ok: true, status: 'point', point: { x: 20, y: 30 } },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(paneRes.classification, 'harmless_miss');
    assert.equal(paneRes.element.control_type, 'Pane');

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

  it('enforces leaf-fallback uniqueness and forbids name-only leaf matching', () => {
    const el7 = syntheticTree.find((el) => el.automation_id === 'num7Button');
    // 1. Unique on-screen automation_id fallback works even when ancestor steps differ
    const shallowExpected7 = [winStep, btn7Step];
    assert.equal(matchesExpectedSelector(el7, shallowExpected7, syntheticTree), true);

    // 2. Duplicate on-screen automation_id (e.g. two CloseButton buttons) rejects leaf fallback
    const dupBtnA = {
      control_type: 'Button',
      automation_id: 'CloseButton',
      name: 'OK',
      is_offscreen: false,
      selector: [winStep, { control_type: 'Window', name: 'Dialog', automation_id: null, index: 0 }, { control_type: 'Button', name: 'OK', automation_id: 'CloseButton', index: 0 }],
    };
    const dupBtnB = {
      control_type: 'Button',
      automation_id: 'CloseButton',
      name: 'Close Tab',
      is_offscreen: false,
      selector: [winStep, { control_type: 'Tab', name: null, automation_id: 'Tabs', index: 0 }, { control_type: 'Button', name: 'Close Tab', automation_id: 'CloseButton', index: 0 }],
    };
    const treeWithDups = [...syntheticTree, dupBtnA, dupBtnB];
    const ambiguousExpected = [winStep, { control_type: 'Button', name: 'Close Tab', automation_id: 'CloseButton', index: 0 }];
    assert.equal(matchesExpectedSelector(dupBtnA, ambiguousExpected, treeWithDups), false);
    assert.equal(matchesExpectedSelector(dupBtnB, ambiguousExpected, treeWithDups), false);
    // Full selector still matches exactly
    assert.equal(matchesExpectedSelector(dupBtnB, dupBtnB.selector, treeWithDups), true);

    // 3. Name-only leaf (automation_id: null) never falls back when ancestor path differs
    const tabItemEl = {
      control_type: 'TabItem',
      automation_id: null,
      name: 'Untitled',
      is_offscreen: false,
      selector: [winStep, paneStep, { control_type: 'TabItem', automation_id: null, name: 'Untitled', index: 0 }],
    };
    const treeWithTab = [...syntheticTree, tabItemEl];
    const shallowTabExpected = [winStep, { control_type: 'TabItem', automation_id: null, name: 'Untitled', index: 0 }];
    assert.equal(matchesExpectedSelector(tabItemEl, shallowTabExpected, treeWithTab), false);
    assert.equal(matchesExpectedSelector(tabItemEl, tabItemEl.selector, treeWithTab), true);
  });

  it('classifies targets missing from tree as invalid_target and transport failures as transport_error', () => {
    const missingExpected = [
      winStep,
      { control_type: 'Button', automation_id: 'nonExistentButton', name: 'Missing', index: 0 },
    ];
    assert.equal(targetExistsInTree(syntheticTree, missingExpected), false);

    const invalidRes = scoreResponse({
      parsed: { ok: true, status: 'point', point: { x: 80, y: 180 } },
      tree: syntheticTree,
      expected: missingExpected,
      meta: syntheticMeta,
    });
    assert.equal(invalidRes.classification, 'invalid_target');

    const transportRes = scoreResponse({
      parsed: { ok: false, status: 'transport_error', error: 'HTTP 503' },
      tree: syntheticTree,
      expected: expectedBtn7,
      meta: syntheticMeta,
    });
    assert.equal(transportRes.classification, 'transport_error');
  });
});

describe('4. DPI / window_rect coordinate mapping', () => {
  it('maps image pixels in a 150% DPI window (144 DPI) to the right physical screen point', () => {
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

describe('6. Report formatting, rate computation, and exclusion of invalid_target & transport_error', () => {
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
    {
      grounder: 'ui-tars-1.5-7b',
      model: 'bytedance/ui-tars-1.5-7b',
      app: 'calculator',
      target_id: 't-missing',
      hard: true,
      classification: 'invalid_target',
      latency_ms: 550,
      usage: { prompt_tokens: 1000, completion_tokens: 20 },
    },
    {
      grounder: 'ui-tars-1.5-7b',
      model: 'bytedance/ui-tars-1.5-7b',
      app: 'calculator',
      target_id: 't-netfail',
      hard: true,
      classification: 'transport_error',
      latency_ms: 60000,
      usage: null,
    },
  ];

  const pricing = new Map([
    ['bytedance/ui-tars-1.5-7b', { prompt: 0.000001, completion: 0.000002, image: 0, request: 0 }],
  ]);

  it('excludes invalid_target and transport_error from rate denominators, lists excluded target IDs, and reports hit >= 85.0% threshold', () => {
    const summary = computeSummary(sampleRecords, pricing);
    assert.equal(summary.metric_order[0], 'wrong_element');
    assert.equal(summary.by_grounder_app.length, 1);

    const row = summary.by_grounder_app[0];
    // Only the 5 scored records count toward total
    assert.equal(row.total, 5);
    assert.equal(row.raw_total, 7);
    assert.equal(row.counts.wrong_element, 1);
    assert.equal(row.counts.hit, 1);
    assert.equal(row.counts.harmless_miss, 1);
    assert.equal(row.counts.not_found, 1);
    assert.equal(row.counts.parse_error, 1);
    assert.equal(row.counts.invalid_target, 1);
    assert.equal(row.counts.transport_error, 1);
    assert.deepEqual(row.excluded_target_ids, ['t-missing']);
    assert.equal(row.rates.wrong_element, 0.2);
    assert.equal(row.rates.hit, 0.2);

    // Hard split: 2 scored hard targets (t-missing and t-netfail excluded)
    assert.equal(row.hard.total, 2);
    assert.equal(row.hard.counts.wrong_element, 1);
    assert.equal(row.hard.rates.wrong_element, 0.5);
    assert.equal(row.hard.counts.harmless_miss, 1);
    assert.equal(row.hard.rates.harmless_miss, 0.5);
    assert.equal(row.hard.counts.invalid_target, 1);
    assert.equal(row.hard.counts.transport_error, 1);

    const md = renderMarkdownReport(summary);
    assert.match(md, /`?hit`? ≥ 85\.0%/);
    assert.match(md, /`?wrong_element`?\*{0,2} ≤ 2\.0%/);
    assert.match(md, /t-missing/);
    const headerLine = md
      .split('\n')
      .find((line) => line.startsWith('| Grounder | App |'));
    assert.ok(headerLine, 'Expected Grounder x App Markdown table header');
    const cols = headerLine
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    assert.equal(cols[0], 'Grounder');
    assert.equal(cols[1], 'App');
    assert.equal(cols[2], '**wrong_element**');
    assert.equal(cols[3], 'hit');
  });
});

describe('7. Pre-flight safety, secret scrubbing, and committed fixture/target verbatim alignment', () => {
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

  it('targets/calculator.json and targets/notepad.json each have 50 targets (>=10 hard) matching an on-screen element in fixtures/<app>/tree.json verbatim', () => {
    for (const app of ['calculator', 'notepad']) {
      const targetPath = path.join(BAKEOFF_DIR, 'targets', `${app}.json`);
      const treePath = path.join(BAKEOFF_DIR, 'fixtures', app, 'tree.json');
      const targets = parseJsonNoBom(readFileSync(targetPath, 'utf8'));
      const tree = parseJsonNoBom(readFileSync(treePath, 'utf8'));

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

        const exactOnscreenMatch = tree.find(
          (el) => el && el.is_offscreen !== true && selectorsEqual(el.selector, t.expected),
        );
        assert.ok(
          exactOnscreenMatch,
          `Target ${t.id} in ${app}.json does not match any on-screen element in fixtures/${app}/tree.json verbatim`,
        );
      }
      assert.ok(hardCount >= 10, `Expected >=10 hard targets in ${app}.json, got ${hardCount}`);
    }
  });

  it('capture.ps1 follows fixed-script + JSON-params discipline and closes only $startedPid and its descendants', () => {
    const ps1 = readFileSync(CAPTURE_PS1_PATH, 'utf8');
    assert.match(ps1, /\[string\]\$ParamsFile/);
    assert.match(ps1, /PrintWindow/);
    assert.match(ps1, /PW_RENDERFULLCONTENT/);
    assert.match(ps1, /GetDpiForWindow/);
    assert.match(ps1, /ControlViewWalker/);
    assert.match(ps1, /ParentProcessId/);
    assert.match(ps1, /Add-DescendantPids/);
    assert.equal(ps1.includes('Invoke-Expression'), false);
  });

  it('grounders.config.json provides non-hardcoded model IDs and coordinate modes', () => {
    const cfg = loadGroundersConfig();
    const table = buildGrounderTable(cfg);
    assert.equal(table['ui-tars-1.5-7b'].model, 'bytedance/ui-tars-1.5-7b');
    assert.equal(table['ui-tars-1.5-7b'].coord_mode, 'smart_resize');
    assert.equal(table.claude.model, cfg.models.claude);
    assert.equal(table.claude.coord_mode, 'pixels');
    assert.equal(table.qwen.model, cfg.models.qwen);
    assert.equal(table.qwen.coord_mode, 'norm1000');
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

describe('8. Run harness: CLI flags, resume accounting, deadline/transport_error, and rescore.mjs', () => {
  it('parseRunArgs parses --concurrency and --deadline-ms', () => {
    const parsed = parseRunArgs([
      'node',
      'run.mjs',
      '--apps',
      'calculator',
      '--grounders',
      'ui-tars-1.5-7b',
      '--concurrency',
      '4',
      '--deadline-ms',
      '15000',
      '--limit',
      '2',
    ]);
    assert.equal(parsed.concurrency, 4);
    assert.equal(parsed.deadlineMs, 15000);
    assert.equal(parsed.limit, 2);

    assert.throws(() => parseRunArgs(['node', 'run.mjs', '--concurrency', '0']), /--concurrency/);
    assert.throws(() => parseRunArgs(['node', 'run.mjs', '--deadline-ms', '-5']), /--deadline-ms/);
  });

  it('skips existing call records on resume and counts only current-plan records in resumedRecords', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'bakeoff-resume-'));
    try {
      const fixtureDir = path.join(tmpRoot, 'fixtures', 'calculator');
      const targetsDir = path.join(tmpRoot, 'targets');
      const outDir = path.join(tmpRoot, 'out');
      const callsDir = path.join(outDir, 'calls');
      mkdirSync(fixtureDir, { recursive: true });
      mkdirSync(targetsDir, { recursive: true });
      mkdirSync(callsDir, { recursive: true });

      // 1x1 PNG
      writeFileSync(
        path.join(fixtureDir, 'window.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      const winStep = { control_type: 'Window', name: 'Calculator', automation_id: null, index: 0 };
      const btnStep = { control_type: 'Button', name: 'Zero', automation_id: 'num0Button', index: 0 };
      writeFileSync(
        path.join(fixtureDir, 'meta.json'),
        JSON.stringify({
          dpi: 96,
          window_rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
          image_size: { width: 100, height: 100 },
        }),
      );
      writeFileSync(
        path.join(fixtureDir, 'tree.json'),
        JSON.stringify([
          {
            control_type: 'Window',
            name: 'Calculator',
            automation_id: null,
            enabled: true,
            is_offscreen: false,
            bounding_rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
            selector: [winStep],
          },
          {
            control_type: 'Button',
            name: 'Zero',
            automation_id: 'num0Button',
            enabled: true,
            is_offscreen: false,
            bounding_rect: { left: 10, top: 10, right: 90, bottom: 90, width: 80, height: 80 },
            selector: [winStep, btnStep],
          },
        ]),
      );
      writeFileSync(
        path.join(targetsDir, 'calculator.json'),
        JSON.stringify([
          { id: 'calc-01', description: 'Zero', hard: false, expected: [winStep, btnStep] },
          { id: 'calc-02', description: 'Zero again', hard: true, expected: [winStep, btnStep] },
        ]),
      );

      // Pre-populate calc-01 in calls/ AND an unrelated leftover file not in the current plan
      writeFileSync(
        path.join(callsDir, 'claude__calculator__calc-01__r1.json'),
        JSON.stringify({
          key: 'claude__calculator__calc-01__r1',
          grounder: 'claude',
          model: 'anthropic/claude-sonnet-5.5',
          app: 'calculator',
          target_id: 'calc-01',
          description: 'Zero',
          hard: false,
          repeat: 1,
          raw_reply: '{"x": 50, "y": 50}',
          parse_status: 'point',
          parsed_point: { x: 50, y: 50 },
          screen_point: { x: 50, y: 50 },
          classification: 'hit',
          hit_element: { control_type: 'Button', automation_id: 'num0Button', name: 'Zero', selector: [winStep, btnStep] },
          latency_ms: 120,
          usage: { prompt_tokens: 100, completion_tokens: 10 },
          error: null,
        }),
      );
      writeFileSync(
        path.join(callsDir, 'unrelated_grounder__notepad__notepad-99__r1.json'),
        JSON.stringify({
          key: 'unrelated_grounder__notepad__notepad-99__r1',
          grounder: 'unrelated_grounder',
          model: 'other/model',
          app: 'notepad',
          target_id: 'notepad-99',
          classification: 'hit',
          latency_ms: 100,
        }),
      );

      let completionFetchCalls = 0;
      const mockFetch = async (url) => {
        if (String(url).endsWith('/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0', completion: '0' } }],
            }),
          };
        }
        completionFetchCalls += 1;
        const payload = {
          choices: [{ message: { content: '{"x": 40, "y": 40}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        };
        return {
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      };

      const res = await runBakeoff({
        apps: ['calculator'],
        grounderIds: ['claude'],
        repeat: 1,
        outDir,
        fixturesDir: path.join(tmpRoot, 'fixtures'),
        targetsDir,
        env: { OPENROUTER_API_KEY: 'sk-or-v1-testkey' },
        fetchFn: mockFetch,
      });

      assert.equal(completionFetchCalls, 1, 'Should only call fetchFn for calc-02, skipping calc-01');
      assert.equal(res.resumedRecords, 1, 'resumedRecords must count only planned records (1), ignoring unrelated file');
      assert.equal(res.executedRecords, 1);
      assert.equal(res.totalRecords, 2);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('maps deadline/network/HTTP failures to transport_error and run.mjs main() returns 1 when transport_error > 10%', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'bakeoff-transport-'));
    try {
      const fixtureDir = path.join(tmpRoot, 'fixtures', 'calculator');
      const targetsDir = path.join(tmpRoot, 'targets');
      const outDir = path.join(tmpRoot, 'out');
      mkdirSync(fixtureDir, { recursive: true });
      mkdirSync(targetsDir, { recursive: true });

      writeFileSync(
        path.join(fixtureDir, 'window.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      const winStep = { control_type: 'Window', name: 'Calculator', automation_id: null, index: 0 };
      const btnStep = { control_type: 'Button', name: 'Zero', automation_id: 'num0Button', index: 0 };
      writeFileSync(
        path.join(fixtureDir, 'meta.json'),
        JSON.stringify({
          dpi: 96,
          window_rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
          image_size: { width: 100, height: 100 },
        }),
      );
      writeFileSync(
        path.join(fixtureDir, 'tree.json'),
        JSON.stringify([
          {
            control_type: 'Window',
            name: 'Calculator',
            automation_id: null,
            enabled: true,
            is_offscreen: false,
            bounding_rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
            selector: [winStep],
          },
          {
            control_type: 'Button',
            name: 'Zero',
            automation_id: 'num0Button',
            enabled: true,
            is_offscreen: false,
            bounding_rect: { left: 10, top: 10, right: 90, bottom: 90, width: 80, height: 80 },
            selector: [winStep, btnStep],
          },
        ]),
      );
      writeFileSync(
        path.join(targetsDir, 'calculator.json'),
        JSON.stringify([
          { id: 'calc-01', description: 'Zero', hard: false, expected: [winStep, btnStep] },
        ]),
      );

      // Test deadline abort in callGrounder
      await assert.rejects(
        () =>
          callGrounder({
            grounder: {
              id: 'claude',
              endpoint: 'https://openrouter.ai/api/v1',
              model: 'anthropic/claude-sonnet-5.5',
              key_env: 'OPENROUTER_API_KEY',
              prompt_style: 'generic',
              coord_mode: 'pixels',
              parser: (raw, sz) => parseGenericJsonOutput(raw, sz),
            },
            imageBase64: Buffer.from('test').toString('base64'),
            imageSize: { width: 100, height: 100 },
            description: 'Zero',
            env: { OPENROUTER_API_KEY: 'sk-or-v1-testkey' },
            deadlineMs: 20,
            fetchFn: (_url, init) =>
              new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                  reject(init.signal.reason ?? new Error('Aborted'));
                });
              }),
          }),
        (err) => {
          assert.equal(err.code, 'E_TRANSPORT_ERROR');
          return true;
        },
      );

      // Test runBakeoff + main exit code when HTTP 502 occurs
      const failingFetch = async (url) => {
        if (String(url).endsWith('/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0', completion: '0' } }],
            }),
          };
        }
        return {
          ok: false,
          status: 502,
          text: async () => 'Bad Gateway',
        };
      };

      const res = await runBakeoff({
        apps: ['calculator'],
        grounderIds: ['claude'],
        repeat: 1,
        outDir,
        fixturesDir: path.join(tmpRoot, 'fixtures'),
        targetsDir,
        env: { OPENROUTER_API_KEY: 'sk-or-v1-testkey' },
        fetchFn: failingFetch,
      });

      assert.equal(res.transportErrorCount, 1);
      assert.equal(res.transportErrorRate, 1);
      assert.equal(res.summary.by_grounder_app[0].total, 0);
      assert.equal(res.summary.by_grounder_app[0].counts.transport_error, 1);

      let loggedError = '';
      const code = await runMain(
        ['node', 'run.mjs', '--apps', 'calculator', '--grounders', 'claude', '--out', outDir],
        {
          fixturesDir: path.join(tmpRoot, 'fixtures'),
          targetsDir,
          env: { OPENROUTER_API_KEY: 'sk-or-v1-testkey' },
          fetchFn: failingFetch,
          logger: { log: () => {}, error: (msg) => { loggedError += msg; } },
        },
      );
      assert.equal(code, 1);
      assert.match(loggedError, /Transport errors exceeded 10%/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rescoreBakeoffDir re-parses raw_reply, preserves classification_v1 across runs, and regenerates report.md & summary.json', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'bakeoff-rescore-'));
    try {
      const callsDir = path.join(tmpRoot, 'calls');
      mkdirSync(callsDir, { recursive: true });

      // Use real calculator fixture and target calc-01 (num0Button) with UI-TARS-1.5 (351,996)
      const callFile = path.join(callsDir, 'ui-tars-1.5-7b__calculator__calc-01__r1.json');
      writeFileSync(
        callFile,
        JSON.stringify({
          key: 'ui-tars-1.5-7b__calculator__calc-01__r1',
          grounder: 'ui-tars-1.5-7b',
          model: 'bytedance/ui-tars-1.5-7b',
          app: 'calculator',
          target_id: 'calc-01',
          description: 'the Zero (0) button',
          hard: false,
          repeat: 1,
          raw_reply: "Thought: Click zero.\nAction: click(start_box='(351,996)')",
          parse_status: 'point',
          parsed_point: { x: 492, y: 1074 },
          screen_point: { x: 518, y: 1225 },
          classification: 'harmless_miss',
          hit_element: null,
          latency_ms: 2100,
          usage: { prompt_tokens: 1000, completion_tokens: 25 },
          error: null,
        }),
      );

      const first = await rescoreBakeoffDir({ inDir: tmpRoot });
      assert.equal(first.rescoredCount, 1);
      assert.equal(first.summary.by_grounder_app[0].counts.hit, 1);

      const updated1 = parseJsonNoBom(readFileSync(callFile, 'utf8'));
      assert.equal(updated1.classification_v1, 'harmless_miss');
      assert.equal(updated1.classification, 'hit');
      assert.deepEqual(updated1.parsed_point, { x: 352, y: 1009 });
      // Screen point = fixture window origin + image pixel (image is captured at physical size).
      assert.ok(updated1.screen_point && Number.isFinite(updated1.screen_point.x) && Number.isFinite(updated1.screen_point.y));
      assert.equal(updated1.hit_element.automation_id, 'num0Button');

      // Second rescore must keep classification_v1 as 'harmless_miss'
      await rescoreBakeoffDir({ inDir: tmpRoot });
      const updated2 = parseJsonNoBom(readFileSync(callFile, 'utf8'));
      assert.equal(updated2.classification_v1, 'harmless_miss');
      assert.equal(updated2.classification, 'hit');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// Orchestrator round 2b: hit-testing mirrors UIA ElementFromPoint on non-nested trees.
describe('9. Hit-test realism on overlapping, non-nested UIA trees', () => {
  const win = { control_type: 'Window', automation_id: null, name: 'App', index: 0 };
  const meta = { window_rect: { left: 0, top: 0, right: 1000, bottom: 800 }, image_size: { width: 1000, height: 800 }, dpi: 96 };
  const tree = [
    { control_type: 'Window', automation_id: null, name: 'App', enabled: true, is_offscreen: false, bounding_rect: { left: 0, top: 0, right: 1000, bottom: 800 }, selector: [win] },
    // a full-window overlay in another branch, deeper by selector length
    { control_type: 'Window', automation_id: null, name: '', enabled: true, is_offscreen: false, bounding_rect: { left: 0, top: 0, right: 1000, bottom: 800 }, selector: [win, { control_type: 'Pane', automation_id: 'host', name: null, index: 0 }, { control_type: 'Window', automation_id: null, name: '', index: 0 }] },
    { control_type: 'Button', automation_id: 'Close', name: 'Close', enabled: true, is_offscreen: false, bounding_rect: { left: 950, top: 0, right: 1000, bottom: 40 }, selector: [win, { control_type: 'Button', automation_id: 'Close', name: 'Close', index: 0 }] },
    { control_type: 'Button', automation_id: 'Max', name: 'Maximize', enabled: true, is_offscreen: false, bounding_rect: { left: 900, top: 0, right: 950, bottom: 40 }, selector: [win, { control_type: 'Button', automation_id: 'Max', name: 'Maximize', index: 0 }] },
    { control_type: 'Document', automation_id: 'Doc', name: 'Text', enabled: true, is_offscreen: false, bounding_rect: { left: 0, top: 100, right: 1000, bottom: 800 }, selector: [win, { control_type: 'Document', automation_id: 'Doc', name: 'Text', index: 0 }] },
    // overlay pane over the document, NOT its child
    { control_type: 'Pane', automation_id: 'Scroll', name: null, enabled: true, is_offscreen: false, bounding_rect: { left: 0, top: 120, right: 980, bottom: 780 }, selector: [win, { control_type: 'Pane', automation_id: 'Scroll', name: null, index: 0 }] },
  ];
  const sel = (id) => tree.find((e) => e.automation_id === id).selector;
  const parsed = (x, y) => ({ ok: true, status: 'point', point: { x, y } });

  it('picks the smallest containing element, not the deepest overlay', () => {
    assert.equal(__findAt(tree, { x: 975, y: 20 }).automation_id, 'Close');
  });
  it('a caption-button click is a hit even under a deeper full-window overlay', () => {
    assert.equal(__score({ parsed: parsed(975, 20), tree, expected: sel('Close'), meta }).classification, 'hit');
  });
  it('a click on a non-actionable overlay inside the target rect is a hit', () => {
    assert.equal(__score({ parsed: parsed(500, 500), tree, expected: sel('Doc'), meta }).classification, 'hit');
  });
  it('an adjacent actionable control is still wrong_element', () => {
    assert.equal(__score({ parsed: parsed(925, 20), tree, expected: sel('Close'), meta }).classification, 'wrong_element');
  });
});

// Review round 2 (Grok) findings A-C.
describe('10. Review r2: actionable-first hit-testing, malformed-reply recovery, Qwen prompt', () => {
  it('A: a click on another tab title (non-actionable Text inside that TabItem) is wrong_element', () => {
    const tree = parseJsonNoBom(readFileSync(path.join(BAKEOFF_DIR, 'fixtures', 'notepad', 'tree.json'), 'utf8'));
    const meta = parseJsonNoBom(readFileSync(path.join(BAKEOFF_DIR, 'fixtures', 'notepad', 'meta.json'), 'utf8'));
    const tabB = tree.find((e) => e.control_type === 'TabItem' && String(e.name).startsWith('notes-b.txt'));
    const titleA = tree.find((e) => e.control_type === 'Text' && e.name === 'notes-a.txt');
    assert.ok(tabB && titleA, 'fixture has both tabs');
    const r = titleA.bounding_rect;
    const screen = { x: Math.floor((r.left + r.right) / 2), y: Math.floor((r.top + r.bottom) / 2) };
    const img = { x: screen.x - meta.window_rect.left, y: screen.y - meta.window_rect.top };
    const scored = __score({ parsed: { ok: true, status: 'point', point: img }, tree, expected: tabB.selector, meta });
    assert.equal(scored.classification, 'wrong_element');
    assert.equal(scored.element.control_type, 'TabItem');
  });
  it('B: malformed replies that carry a point are recovered and flagged, not hidden as parse_error', () => {
    const size = { width: 1402, height: 1078 };
    for (const raw of ['{"x": 914, 20}', '{"x": [247, 727], "y": [727}', '{"x": "89", "y": "727"}', '{"x_1": 500, "y_1": 400}']) {
      const p = parseGenericJsonOutput(raw, size, undefined, { coordMode: 'norm1000' });
      assert.equal(p.ok, true, raw);
      assert.equal(p.recovered, true, raw);
    }
    const p = parseGenericJsonOutput('{"x_1": 500, "y_1": 400}', size, undefined, { coordMode: 'norm1000' });
    assert.deepEqual(p.point, { x: 701, y: 431 }, 'digits inside key names are not read as coordinates');
    assert.equal(parseGenericJsonOutput('I cannot see it.', size, undefined, { coordMode: 'norm1000' }).status, 'parse_error');
    assert.equal(parseGenericJsonOutput('{"not_found": true', size, undefined, { coordMode: 'norm1000' }).status, 'not_found');
  });
  it('C: Qwen is asked for 0-1000 coordinates and parsed as norm1000; Claude keeps pixels', () => {
    const table = buildGrounderTable(loadGroundersConfig());
    assert.equal(table.qwen.prompt_style, 'generic-norm1000');
    assert.match(buildGrounderPrompt('generic-norm1000', 'the 0 key', { width: 10, height: 10 }), /0-1000/);
    assert.equal(table.claude.prompt_style, 'generic');
    assert.equal(table.claude.coord_mode, 'pixels');
  });
});
