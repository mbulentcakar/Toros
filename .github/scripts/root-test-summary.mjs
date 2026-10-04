import { appendFile } from 'node:fs/promises';

export const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
export const REQUIRED_SUMMARY_KEYS = ['tests', 'pass', 'fail', 'skipped'];

/** Parse the terminal totals emitted by Node 24's explicitly selected TAP reporter. */
export function parseTapSummary(output) {
  const totals = new Map();
  const totalPattern = /^\s*#\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm;

  for (const match of output.matchAll(totalPattern)) {
    totals.set(match[1], Number.parseInt(match[2], 10));
  }

  return totals;
}

export function missingRequiredTotals(totals) {
  return REQUIRED_SUMMARY_KEYS.filter((name) => !totals.has(name));
}

export function selectExitCode(testExitCode, totals) {
  if (testExitCode !== 0) return testExitCode;
  return missingRequiredTotals(totals).length === 0 ? 0 : 1;
}

export function formatSummary(totals) {
  const lines = ['## Root test summary', '', '- reporter: **Node 24 TAP**'];
  for (const name of SUMMARY_KEYS) {
    if (totals.has(name)) lines.push(`- ${name}: **${totals.get(name)}**`);
  }

  const missing = missingRequiredTotals(totals);
  if (missing.length > 0) {
    lines.push(`- summary contract: **failed (missing ${missing.join(', ')})**`);
  }
  return `${lines.join('\n')}\n`;
}

export async function appendSummary(summaryPath, totals) {
  if (summaryPath === undefined || summaryPath.length === 0) {
    throw new Error('GITHUB_STEP_SUMMARY is required');
  }
  await appendFile(summaryPath, formatSummary(totals), 'utf8');
}
