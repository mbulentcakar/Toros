/**
 * Acceptance tests for amendment A8 `authorizeTargets` (two-phase target policy).
 *
 * Pure and deterministic: no registry/workspace state is consulted, so the
 * policy under test needs only a constructed envelope and session id.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AppIdentity, JobEnvelope, ResolvedTarget } from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { createRegistry } from '@toros/registry';
import { createPolicy } from '../src/index.js';

function makeIdentity(overrides: Partial<AppIdentity> = {}): AppIdentity {
  return {
    pid: 1234,
    created_at: '2026-01-01T00:00:00Z',
    image_path: 'C:\\Program Files\\Contoso\\app.exe',
    image_sha256: 'a'.repeat(64),
    signature: 'valid',
    signer: 'Contoso Corp',
    product_name: 'Contoso Editor',
    session_id: 7,
    ...overrides,
  };
}

function appTarget(key: string, identity: AppIdentity = makeIdentity()): ResolvedTarget {
  return { kind: 'app', key, identity };
}

function capabilityTarget(key: string, capability: string): ResolvedTarget {
  return { kind: 'capability', key, capability };
}

function makeEnvelope(apps?: readonly unknown[]): { envelope: JobEnvelope; digest: string } {
  const sealed = sealEnvelope({
    job_id: '00000000-0000-0000-0000-000000000001',
    objective: 'test',
    allowed_capabilities: ['file.read'],
    allowed_workspaces: ['main'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 3,
    max_retries: 2,
    expires_at: '2030-01-01T00:00:00Z',
    ...(apps === undefined ? {} : { allowed_apps: apps as never }),
  });
  return { envelope: sealed.envelope, digest: sealed.envelope_digest };
}

function makePolicy(desktopSessionId?: number | null): ReturnType<typeof createPolicy> {
  const registry = createRegistry({ workspaces: [], platform: 'linux' });
  return createPolicy({
    registry,
    approval_required: [],
    ...(desktopSessionId === undefined ? {} : { desktop_session_id: desktopSessionId }),
  });
}

describe('@toros/policy authorizeTargets (amendment A8)', () => {
  it('with no allowed_apps, denies every app target and leaves capability targets unaffected', () => {
    const { envelope } = makeEnvelope(undefined);
    const policy = makePolicy(7);
    const decisions = policy.authorizeTargets(envelope, 'file.read', [
      appTarget('a'),
      capabilityTarget('c', 'file.read'),   // allowed capability
      capabilityTarget('d', 'other.cap'),   // not in allowed_capabilities
    ]);
    assert.equal(decisions.get('a'), 'denied');
    assert.equal(decisions.get('c'), 'allowed');
    assert.equal(decisions.get('d'), 'denied');
  });

  it('denies every app target when the desktop session is unknown (fail closed)', () => {
    const { envelope } = makeEnvelope([{ image_sha256: 'a'.repeat(64) }]);
    for (const sessionId of [undefined, null]) {
      const policy = makePolicy(sessionId);
      assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('a')]).get('a'), 'denied');
    }
  });

  it('allows an app whose image_sha256 matches a rule, and denies a mismatch', () => {
    const { envelope } = makeEnvelope([{ image_sha256: 'a'.repeat(64) }]);
    const policy = makePolicy(7);
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('match')]).get('match'), 'allowed');
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('miss', makeIdentity({ image_sha256: 'b'.repeat(64) }))]).get('miss'), 'denied');
  });

  it('allows an app whose signer and product_name match, case-sensitively', () => {
    const { envelope } = makeEnvelope([{ signer: 'Contoso Corp', product_name: 'Contoso Editor' }]);
    const policy = makePolicy(7);
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('match')]).get('match'), 'allowed');
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('miss-case', makeIdentity({ signer: 'contoso corp' }))]).get('miss-case'), 'denied');
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('miss-product', makeIdentity({ product_name: 'Other' }))]).get('miss-product'), 'denied');
  });

  it('ignores a signer rule when the signature is unsigned or invalid', () => {
    const { envelope } = makeEnvelope([{ signer: 'Contoso Corp', product_name: 'Contoso Editor' }]);
    const policy = makePolicy(7);
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('unsigned', makeIdentity({ signature: 'unsigned' }))]).get('unsigned'), 'denied');
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('invalid', makeIdentity({ signature: 'invalid' }))]).get('invalid'), 'denied');
  });

  it('allows an app whose image_path matches case- and separator-insensitively', () => {
    const { envelope } = makeEnvelope([{ image_path: 'C:\\Program Files\\Contoso\\app.exe' }]);
    const policy = makePolicy(7);
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('match')]).get('match'), 'allowed');
    assert.equal(
      policy.authorizeTargets(envelope, 'file.read', [appTarget('match-fwd', makeIdentity({ image_path: 'c:/program files/contoso/app.exe' }))]).get('match-fwd'),
      'allowed',
    );
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('miss', makeIdentity({ image_path: 'C:\\Program Files\\Other\\app.exe' }))]).get('miss'), 'denied');
  });

  it('denies an app whose basename matches a forbidden term even when a rule matches', () => {
    const sealed = sealEnvelope({
      job_id: '00000000-0000-0000-0000-000000000002',
      objective: 'test', allowed_capabilities: ['file.read'], allowed_workspaces: ['main'],
      acceptance: ['done'], forbidden: ['app'], max_actions: 3, max_retries: 2,
      expires_at: '2030-01-01T00:00:00Z',
      allowed_apps: [{ image_sha256: 'a'.repeat(64) }],
    });
    const policy = makePolicy(7);
    assert.equal(policy.authorizeTargets(sealed.envelope, 'file.read', [appTarget('forbidden-basename')]).get('forbidden-basename'), 'denied');
  });

  it('denies an app whose product_name or signer matches a forbidden term', () => {
    const byProduct = sealEnvelope({
      job_id: '00000000-0000-0000-0000-000000000003',
      objective: 'test', allowed_capabilities: ['file.read'], allowed_workspaces: ['main'],
      acceptance: ['done'], forbidden: ['contoso'], max_actions: 3, max_retries: 2,
      expires_at: '2030-01-01T00:00:00Z',
      allowed_apps: [{ image_sha256: 'a'.repeat(64) }],
    });
    const policy = makePolicy(7);
    // product_name "Contoso Editor" contains the token Contoso; signer too.
    assert.equal(policy.authorizeTargets(byProduct.envelope, 'file.read', [appTarget('p')]).get('p'), 'denied');
  });

  it('denies an app whose session id differs from the node session', () => {
    const { envelope } = makeEnvelope([{ image_sha256: 'a'.repeat(64) }]);
    const policy = makePolicy(7);
    assert.equal(policy.authorizeTargets(envelope, 'file.read', [appTarget('other-session', makeIdentity({ session_id: 3 }))]).get('other-session'), 'denied');
  });

  it('is deterministic: the same inputs yield the same map every call', () => {
    const { envelope } = makeEnvelope([{ image_sha256: 'a'.repeat(64) }]);
    const policy = makePolicy(7);
    const targets = [appTarget('a'), appTarget('b', makeIdentity({ image_sha256: 'b'.repeat(64) })), capabilityTarget('c', 'other.cap')];
    const first = policy.authorizeTargets(envelope, 'file.read', targets);
    const second = policy.authorizeTargets(envelope, 'file.read', targets);
    assert.deepEqual([...first.entries()], [...second.entries()]);
  });
});