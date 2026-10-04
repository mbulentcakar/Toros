import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  appendSummary,
  missingRequiredTotals,
  parseTapSummary,
  selectExitCode,
} from './root-test-summary.mjs';

function runTestProcess() {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) {
    throw new Error(`npm CLI not found beside Node at ${npmCli}`);
  }
  const args = [npmCli, 'test'];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        NODE_OPTIONS: '--test-reporter=tap',
      },
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      process.stderr.write(text);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main() {
  let result;
  try {
    result = await runTestProcess();
  } catch (error) {
    console.error(`Unable to start npm test: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const totals = parseTapSummary(result.output);
  try {
    await appendSummary(process.env.GITHUB_STEP_SUMMARY, totals);
  } catch (error) {
    console.error(`Unable to write the Root job summary: ${error instanceof Error ? error.message : String(error)}`);
    return result.code === 0 ? 1 : result.code;
  }

  const missing = missingRequiredTotals(totals);
  if (missing.length > 0) {
    console.error(`Node TAP summary contract failed: missing ${missing.join(', ')}`);
  }

  return selectExitCode(result.code, totals);
}

process.exitCode = await main();
