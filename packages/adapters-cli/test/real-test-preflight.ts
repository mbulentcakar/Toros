import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RealTestPreflight {
  readonly run: boolean;
  readonly skip: false | string;
}

function nonEmptyEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function credentialFile(base: string | undefined, ...parts: string[]): boolean {
  return base !== undefined && existsSync(join(base, ...parts));
}

function decide(label: string, executablePresent: boolean, credentialPresent: boolean): RealTestPreflight {
  if (process.env.TOROS_REAL_TESTS === '1') {
    return { run: true, skip: false };
  }

  const missing: string[] = [];
  if (!executablePresent) missing.push('binary');
  if (!credentialPresent) missing.push('credential marker');

  if (missing.length === 0) {
    return { run: true, skip: false };
  }

  return {
    run: false,
    skip: `REAL ${label} SKIPPED: missing ${missing.join(' and ')}; set TOROS_REAL_TESTS=1 to force execution.`,
  };
}

export function codexRealTestPreflight(executable: string): RealTestPreflight {
  const codexHome = nonEmptyEnvironmentVariable('CODEX_HOME');
  const userProfile = nonEmptyEnvironmentVariable('USERPROFILE');
  const credentialPresent =
    nonEmptyEnvironmentVariable('OPENAI_API_KEY') !== undefined ||
    (codexHome !== undefined
      ? credentialFile(codexHome, 'auth.json')
      : credentialFile(userProfile, '.codex', 'auth.json'));

  return decide('CODEX', existsSync(executable), credentialPresent);
}

export function claudeRealTestPreflight(executable: string): RealTestPreflight {
  const userProfile = nonEmptyEnvironmentVariable('USERPROFILE');
  const credentialPresent =
    nonEmptyEnvironmentVariable('ANTHROPIC_API_KEY') !== undefined ||
    nonEmptyEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN') !== undefined ||
    credentialFile(userProfile, '.claude', '.credentials.json');

  return decide('CLAUDE', existsSync(executable), credentialPresent);
}
