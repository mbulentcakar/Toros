import type { AppRule } from '@toros/contracts';

/**
 * Desktop configuration parsing (amendment A8, F3b).
 *
 * Kept in its own module so it can be unit-tested without importing `main.ts`,
 * which now starts the service unconditionally at module load. `main.ts` and
 * the tests both import it from here.
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)/;

/**
 * Validate the node's `desktop.authorized_apps` config (amendment A8, F3b).
 *
 * It becomes the same `AppRule[]` shapes the envelope's `allowed_apps` carries —
 * hash, signer+product, or path — instead of the bare basename strings the
 * pilot adapter accepted. A bare string entry (the old basename form) makes Node
 * Core refuse to start with a message naming the new format, because a basename
 * allowlist is spoofable (AR-10) and silently accepting it would suggest the
 * stronger identity bound is in force when it is not.
 */
export function validateDesktopAuthorizedApps(value: unknown, configPath: string): AppRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${configPath}: adapters.desktop.authorized_apps must be an array of application rules`);
  }
  const rules: AppRule[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    // The old basename form: a bare string naming a process file name. Name the
    // new format explicitly rather than a generic "invalid" message.
    if (typeof item === 'string') {
      throw new Error(
        `${configPath}: adapters.desktop.authorized_apps[${i}] "${item}" is a bare string; ` +
        `the new format is an object with exactly one of { image_sha256 }, { signer, product_name }, or { image_path }`,
      );
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] must be an application rule object`);
    }
    const rule = item as Record<string, unknown>;
    for (const key of Object.keys(rule)) {
      if (key !== 'image_sha256' && key !== 'signer' && key !== 'product_name' && key !== 'image_path') {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] unknown property: ${key}`);
      }
    }
    const hasSha = 'image_sha256' in rule;
    const hasSigner = 'signer' in rule;
    const hasProduct = 'product_name' in rule;
    const hasPath = 'image_path' in rule;

    if (hasSha) {
      if (hasSigner || hasProduct || hasPath) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] must have exactly one rule shape`);
      }
      const sha = rule['image_sha256'];
      if (typeof sha !== 'string' || !SHA256_PATTERN.test(sha)) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].image_sha256 must be 64 lower-case hex characters`);
      }
      rules.push({ image_sha256: sha });
      continue;
    }
    if (hasSigner || hasProduct) {
      if (!hasSigner || !hasProduct || hasPath) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] signer and product_name must appear together`);
      }
      const signer = rule['signer'];
      const product = rule['product_name'];
      if (typeof signer !== 'string' || signer.length === 0 || signer.length > 512) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].signer must be a non-empty string ≤ 512 characters`);
      }
      if (typeof product !== 'string' || product.length === 0 || product.length > 512) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].product_name must be a non-empty string ≤ 512 characters`);
      }
      rules.push({ signer, product_name: product });
      continue;
    }
    if (hasPath) {
      const p = rule['image_path'];
      if (typeof p !== 'string' || p.length === 0 || p.length > 512) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].image_path must be a non-empty string ≤ 512 characters`);
      }
      if (!ABSOLUTE_PATH_PATTERN.test(p)) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].image_path must be absolute`);
      }
      rules.push({ image_path: p });
      continue;
    }
    throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] must have exactly one rule shape`);
  }
  return rules;
}