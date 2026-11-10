/**
 * Bakeoff report generator — Toros slice AU0a.
 *
 * Writes `results/<stamp>/report.md` and `summary.json`.
 * The wrong-element rate (`wrong_element`) is the primary safety metric and is
 * always placed in the first metric column in bold.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CLASSIFICATIONS = [
  'wrong_element',
  'hit',
  'harmless_miss',
  'not_found',
  'parse_error',
];

export const EXCLUDED_CLASSIFICATIONS = [
  'transport_error',
  'invalid_target',
];

function createEmptyCounts() {
  return {
    wrong_element: 0,
    hit: 0,
    harmless_miss: 0,
    not_found: 0,
    parse_error: 0,
    transport_error: 0,
    invalid_target: 0,
  };
}

function computeRates(counts, total) {
  if (!total || total <= 0) {
    return {
      wrong_element: 0,
      hit: 0,
      harmless_miss: 0,
      not_found: 0,
      parse_error: 0,
    };
  }
  return {
    wrong_element: counts.wrong_element / total,
    hit: counts.hit / total,
    harmless_miss: counts.harmless_miss / total,
    not_found: counts.not_found / total,
    parse_error: counts.parse_error / total,
  };
}

/**
 * Compute percentile `p` (0..1) from an array of numeric values using
 * nearest-rank method.
 */
export function percentile(values, p) {
  const numeric = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .slice()
    .sort((a, b) => a - b);
  if (numeric.length === 0) return null;
  const idx = Math.min(
    numeric.length - 1,
    Math.max(0, Math.ceil(p * numeric.length) - 1),
  );
  return Math.round(numeric[idx]);
}

function lookupPricing(pricingByModel, modelId, grounderId) {
  if (!pricingByModel) return null;
  if (pricingByModel instanceof Map) {
    return pricingByModel.get(modelId) ?? pricingByModel.get(grounderId) ?? null;
  }
  if (typeof pricingByModel === 'object') {
    return pricingByModel[modelId] ?? pricingByModel[grounderId] ?? null;
  }
  return null;
}

function computeRecordCostUsd(record, pricingByModel) {
  const usage = record?.usage;
  if (!usage || typeof usage !== 'object') return null;

  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return usage.cost;
  }

  const pricing = lookupPricing(pricingByModel, record.model, record.grounder);
  if (!pricing) return null;

  const promptRate = Number(pricing.prompt ?? 0) || 0;
  const completionRate = Number(pricing.completion ?? 0) || 0;
  const imageRate = Number(pricing.image ?? 0) || 0;
  const requestRate = Number(pricing.request ?? 0) || 0;

  const promptTokens = Number(usage.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? 0) || 0;

  if (promptTokens === 0 && completionTokens === 0 && promptRate === 0 && completionRate === 0) {
    return null;
  }

  return (
    promptTokens * promptRate +
    completionTokens * completionRate +
    imageRate +
    requestRate
  );
}

function summarizeGroup(records, pricingByModel) {
  const counts = createEmptyCounts();
  const hardCounts = createEmptyCounts();
  let total = 0;
  let hardTotal = 0;
  const excludedTargetIds = new Set();
  const latencies = [];
  const costs = [];

  for (const rec of records) {
    if (rec.classification === 'invalid_target') {
      counts.invalid_target += 1;
      if (rec.hard === true) {
        hardCounts.invalid_target += 1;
      }
      if (typeof rec.target_id === 'string' && rec.target_id.length > 0) {
        excludedTargetIds.add(rec.target_id);
      }
      continue;
    }

    if (rec.classification === 'transport_error') {
      counts.transport_error += 1;
      if (rec.hard === true) {
        hardCounts.transport_error += 1;
      }
      continue;
    }

    const cls = CLASSIFICATIONS.includes(rec.classification)
      ? rec.classification
      : 'parse_error';
    counts[cls] += 1;
    total += 1;

    if (rec.hard === true) {
      hardCounts[cls] += 1;
      hardTotal += 1;
    }

    if (typeof rec.latency_ms === 'number' && Number.isFinite(rec.latency_ms)) {
      latencies.push(rec.latency_ms);
    }

    const cost = computeRecordCostUsd(rec, pricingByModel);
    if (cost !== null) {
      costs.push(cost);
    }
  }

  const rates = computeRates(counts, total);
  const hardRates = computeRates(hardCounts, hardTotal);

  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);

  const costPer100Usd = costs.length > 0
    ? Number(((costs.reduce((acc, c) => acc + c, 0) / costs.length) * 100).toFixed(6))
    : null;

  const sortedExcludedIds = Array.from(excludedTargetIds).sort();

  return {
    total,
    raw_total: records.length,
    counts,
    rates,
    transport_error: counts.transport_error,
    invalid_target: counts.invalid_target,
    excluded_target_ids: sortedExcludedIds,
    hard: {
      total: hardTotal,
      counts: hardCounts,
      rates: hardRates,
      transport_error: hardCounts.transport_error,
      invalid_target: hardCounts.invalid_target,
    },
    latency_ms: {
      p50,
      p95,
    },
    cost_per_100_usd: costPer100Usd,
  };
}

/**
 * Compute structured summary metrics per `grounder × app` and per `grounder`.
 */
export function computeSummary(records, pricingByModel = null) {
  const safeRecords = Array.isArray(records) ? records : [];

  const pairGroups = new Map();
  const grounderGroups = new Map();
  const allExcludedTargetIds = new Set();
  let transportErrorCount = 0;
  let invalidTargetCount = 0;
  let scoredCallsCount = 0;

  for (const rec of safeRecords) {
    if (rec.classification === 'transport_error') {
      transportErrorCount += 1;
    } else if (rec.classification === 'invalid_target') {
      invalidTargetCount += 1;
      if (typeof rec.target_id === 'string' && rec.target_id.length > 0) {
        allExcludedTargetIds.add(rec.target_id);
      }
    } else {
      scoredCallsCount += 1;
    }

    const grounder = String(rec.grounder ?? 'unknown');
    const app = String(rec.app ?? 'unknown');
    const pairKey = `${grounder}\u0000${app}`;

    if (!pairGroups.has(pairKey)) {
      pairGroups.set(pairKey, {
        grounder,
        model: rec.model ?? null,
        app,
        records: [],
      });
    }
    pairGroups.get(pairKey).records.push(rec);

    if (!grounderGroups.has(grounder)) {
      grounderGroups.set(grounder, {
        grounder,
        model: rec.model ?? null,
        records: [],
      });
    }
    grounderGroups.get(grounder).records.push(rec);
  }

  const byGrounderApp = [];
  for (const group of pairGroups.values()) {
    const stats = summarizeGroup(group.records, pricingByModel);
    byGrounderApp.push({
      grounder: group.grounder,
      model: group.model,
      app: group.app,
      ...stats,
    });
  }

  const byGrounder = [];
  for (const group of grounderGroups.values()) {
    const stats = summarizeGroup(group.records, pricingByModel);
    byGrounder.push({
      grounder: group.grounder,
      model: group.model,
      ...stats,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    total_calls: scoredCallsCount,
    raw_total_calls: safeRecords.length,
    transport_error_count: transportErrorCount,
    invalid_target_count: invalidTargetCount,
    excluded_target_ids: Array.from(allExcludedTargetIds).sort(),
    metric_order: CLASSIFICATIONS,
    by_grounder_app: byGrounderApp,
    by_grounder: byGrounder,
  };
}

function formatCountAndRate(count, rate, bold = false) {
  const pct = `${(rate * 100).toFixed(1)}%`;
  const cell = `${count} (${pct})`;
  return bold ? `**${cell}**` : cell;
}

function formatLatency(val) {
  return typeof val === 'number' && Number.isFinite(val) ? `${val}` : 'n/a';
}

function formatCost(val) {
  return typeof val === 'number' && Number.isFinite(val) ? `$${val.toFixed(4)}` : 'n/a';
}

/**
 * Render the Markdown report with `wrong_element` in the first metric column (bold).
 */
export function renderMarkdownReport(summary) {
  const excludedIds = Array.isArray(summary.excluded_target_ids) ? summary.excluded_target_ids : [];
  const lines = [
    '# Vision Grounding Bakeoff Report (AU0)',
    '',
    '> **Safety priority:** **`wrong_element`** (first metric column) is the primary gating metric.',
    '> A grounder that says "not found" is safe; a grounder that clicks the wrong enabled control is dangerous.',
    '> AU0 target thresholds: **`wrong_element` ≤ 2.0%**, `hit` ≥ 85.0%.',
    '',
    '## Results by Grounder × App (All Targets)',
    '',
    '| Grounder | App | **wrong_element** | hit | harmless_miss | not_found | parse_error | Total | transport_error | invalid_target | p50 (ms) | p95 (ms) | Cost / 100 calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const row of summary.by_grounder_app) {
    lines.push(
      `| ${row.grounder} | ${row.app} | ${formatCountAndRate(row.counts.wrong_element, row.rates.wrong_element, true)} | ${formatCountAndRate(row.counts.hit, row.rates.hit)} | ${formatCountAndRate(row.counts.harmless_miss, row.rates.harmless_miss)} | ${formatCountAndRate(row.counts.not_found, row.rates.not_found)} | ${formatCountAndRate(row.counts.parse_error, row.rates.parse_error)} | ${row.total} | ${row.counts.transport_error ?? 0} | ${row.counts.invalid_target ?? 0} | ${formatLatency(row.latency_ms.p50)} | ${formatLatency(row.latency_ms.p95)} | ${formatCost(row.cost_per_100_usd)} |`,
    );
  }

  lines.push(
    '',
    '## Hard Targets Only (`hard: true`)',
    '',
    '| Grounder | App | **wrong_element** | hit | harmless_miss | not_found | parse_error | Total | transport_error | invalid_target |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  for (const row of summary.by_grounder_app) {
    const h = row.hard;
    lines.push(
      `| ${row.grounder} | ${row.app} | ${formatCountAndRate(h.counts.wrong_element, h.rates.wrong_element, true)} | ${formatCountAndRate(h.counts.hit, h.rates.hit)} | ${formatCountAndRate(h.counts.harmless_miss, h.rates.harmless_miss)} | ${formatCountAndRate(h.counts.not_found, h.rates.not_found)} | ${formatCountAndRate(h.counts.parse_error, h.rates.parse_error)} | ${h.total} | ${h.counts.transport_error ?? 0} | ${h.counts.invalid_target ?? 0} |`,
    );
  }

  lines.push(
    '',
    '## Aggregate by Grounder',
    '',
    '| Grounder | **wrong_element** | hit | harmless_miss | not_found | parse_error | Total | transport_error | invalid_target | p50 (ms) | p95 (ms) | Cost / 100 calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  for (const row of summary.by_grounder) {
    lines.push(
      `| ${row.grounder} | ${formatCountAndRate(row.counts.wrong_element, row.rates.wrong_element, true)} | ${formatCountAndRate(row.counts.hit, row.rates.hit)} | ${formatCountAndRate(row.counts.harmless_miss, row.rates.harmless_miss)} | ${formatCountAndRate(row.counts.not_found, row.rates.not_found)} | ${formatCountAndRate(row.counts.parse_error, row.rates.parse_error)} | ${row.total} | ${row.counts.transport_error ?? 0} | ${row.counts.invalid_target ?? 0} | ${formatLatency(row.latency_ms.p50)} | ${formatLatency(row.latency_ms.p95)} | ${formatCost(row.cost_per_100_usd)} |`,
    );
  }

  lines.push(
    '',
    '## Excluded / Non-Scored Calls',
    '',
    `- **Transport errors (excluded from rates and totals):** ${summary.transport_error_count ?? 0}`,
    `- **Invalid targets (excluded from rates and totals):** ${summary.invalid_target_count ?? 0}`,
    `- **Excluded target IDs:** ${excludedIds.length > 0 ? excludedIds.join(', ') : 'none'}`,
    '',
  );
  return lines.join('\n');
}

/**
 * Write `report.md` and `summary.json` into `outDir`.
 */
export async function writeReport(outDir, records, pricingByModel = null) {
  await fs.mkdir(outDir, { recursive: true });
  const summary = computeSummary(records, pricingByModel);
  const markdown = renderMarkdownReport(summary);

  const reportPath = path.join(outDir, 'report.md');
  const summaryPath = path.join(outDir, 'summary.json');

  await Promise.all([
    fs.writeFile(reportPath, markdown, 'utf8'),
    fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
  ]);

  return {
    reportPath,
    summaryPath,
    summary,
    markdown,
  };
}
