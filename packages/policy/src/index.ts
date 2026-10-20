import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ErrorCode,
  digest,
  isTerminal,
  type AppIdentity,
  type AppRule,
  type ApprovalBinding,
  type ApprovalVerifier,
  type CapabilityId,
  type CapabilityRegistry,
  type JsonValue,
  type JobEnvelope,
  type PolicyDecision,
  type ResolvedTarget,
  type TargetDecisions,
  type Workspace,
  type WorkItemState,
} from '@toros/contracts';
import {
  assertBudget,
  assertDigest,
  assertNotExpired,
  assertRetries,
  isForbidden,
} from '@toros/envelope';
export interface PolicyInput {
  readonly envelope: JobEnvelope;
  /** The digest the caller claims to be acting under. */
  readonly envelope_digest: string;
  readonly state: WorkItemState;
  readonly actions_used: number;
  readonly retries_used: number;
  readonly capability: CapabilityId;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  /** Workspace the action targets, or null for job-level actions. */
  readonly workspace_id: string | null;
  /** Absolute or workspace-relative paths the action will touch. */
  readonly paths: readonly string[];
  /** Approval already granted by the operator for this exact action, if any. */
  readonly approval_token: string | null;
  readonly now: Date;
}

export interface PolicyOptions {
  readonly registry: CapabilityRegistry;
  /** Capability ids that always require approval, beyond schema-declared ones. */
  readonly approval_required: readonly CapabilityId[];
  /**
   * The gate that decides whether a presented approval actually authorises the
   * action. Omitted means NO approval can ever be valid, so every gated action
   * is denied — fail-closed, because a policy that cannot check approvals must
   * not behave as though every approval checks out. That was the old behaviour
   * and it made the gate decorative: any non-empty string passed.
   */
  readonly approvals?: ApprovalVerifier;
  /**
   * The Windows session id Node Core runs in (amendment A8). Passed to policy at
   * construction so `authorizeTargets` can require a resolved app's process to
   * live in that session. Absent or null means every `app` target is denied —
   * fail closed: policy must not guess which session the node is in.
   */
  readonly desktop_session_id?: number | null;
}

export interface Policy {
  decide(input: PolicyInput): PolicyDecision;
  /**
   * Decide each resolved target independently (amendment A8). Deterministic and
   * pure: the same envelope, targets and session yield the same map every call.
   */
  authorizeTargets(envelope: JobEnvelope, capability: CapabilityId, targets: readonly ResolvedTarget[]): TargetDecisions;
}

interface ResolvedWorkspace {
  readonly id: string;
  readonly root: string;
}

const DEVICE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function denial(code: (typeof ErrorCode)[keyof typeof ErrorCode], reason: string): PolicyDecision {
  return { allow: false, code, reason };
}

function stringValues(value: JsonValue): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((item) => stringValues(item));
  }
  return [];
}

function containsForbidden(envelope: JobEnvelope, capability: CapabilityId, args: Readonly<Record<string, JsonValue>>): boolean {
  if (isForbidden(envelope, capability)) return true;
  return Object.values(args).some((value) => stringValues(value).some((text) => isForbidden(envelope, text)));
}

function hasWindowsUnsafeSyntax(candidate: string): boolean {
  if (candidate.includes('\0')) return true;
  if (/^(?:\\\\|\/\/)/.test(candidate)) return true;
  // A DRIVE-RELATIVE path: `C:book.xlsx` — a drive letter and a colon with no
  // separator. Windows resolves it against the process's working directory
  // *for that drive*, so `path.resolve(root, 'C:x')` discards `root` entirely
  // and yields `C:\<cwd-on-C>\x`.
  //
  // Containment already denies the result, because the segment comparison
  // fails — but it denies it because of where Node Core happens to be running,
  // which is not a property anything here asserts, and which stops holding the
  // moment that working directory sits inside a workspace root. Refusing the
  // form outright removes the dependency.
  if (/^[A-Za-z]:[^\\/]/.test(candidate)) return true;
  if (/^\\\\\?\\|^\/\/\?\//.test(candidate)) return true;
  return candidate.split(/[\\/]/u).some((segment) => DEVICE_SEGMENT.test(segment));
}

function realpathWithMissingTail(candidate: string): string {
  let current = candidate;
  const remainder: string[] = [];
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return remainder.reduceRight((parent, segment) => path.join(parent, segment), resolved);
    } catch (error: unknown) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      remainder.push(path.basename(current));
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function normalSegments(value: string): readonly string[] {
  return value.replaceAll('\\', '/').split('/').filter((segment) => segment.length > 0);
}

function isContained(root: string, candidate: string): boolean {
  const rootSegments = normalSegments(root);
  const candidateSegments = normalSegments(candidate);
  if (rootSegments.length > candidateSegments.length) return false;
  const insensitive = process.platform === 'win32';
  return rootSegments.every((segment, index) => {
    const other = candidateSegments[index];
    if (other === undefined) return false;
    return insensitive ? segment.toLowerCase() === other.toLowerCase() : segment === other;
  });
}

function pathIsContained(root: string, candidate: string): boolean {
  if (hasWindowsUnsafeSyntax(candidate)) return false;
  try {
    const absolute = path.resolve(root, candidate);
    const resolved = realpathWithMissingTail(absolute);
    return isContained(root, resolved);
  } catch (_error: unknown) {
    return false;
  }
}

/** Normalise `\` and `/` to a single separator so path equality ignores spelling. */
function normalizeSeparators(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * Whether one `AppRule` matches an `AppIdentity` (amendment A8).
 *
 * - `image_sha256` compares exactly.
 * - `image_path` compares case-insensitively on the full path after separator
 *   normalisation.
 * - `signer` + `product_name` compare exactly, case-sensitively, and only when
 *   the signature is `valid` — an unsigned or invalid image has no trustworthy
 *   signer, so a signer rule must not authorise it.
 */
function appRuleMatches(rule: AppRule, identity: AppIdentity): boolean {
  if ('image_sha256' in rule) {
    return identity.image_sha256 === rule.image_sha256;
  }
  if ('image_path' in rule) {
    return normalizeSeparators(identity.image_path).toLowerCase() === normalizeSeparators(rule.image_path).toLowerCase();
  }
  if (identity.signature !== 'valid') return false;
  return identity.signer === rule.signer && identity.product_name === rule.product_name;
}

class PolicyImpl implements Policy {
  private readonly registry: CapabilityRegistry;
  private readonly approvalRequired: ReadonlySet<CapabilityId>;
  private readonly approvals: ApprovalVerifier | undefined;
  private readonly workspaces: ReadonlyMap<string, ResolvedWorkspace>;
  private readonly desktopSessionId: number | null;

  constructor(options: PolicyOptions) {
    this.registry = options.registry;
    this.approvalRequired = new Set(options.approval_required);
    this.approvals = options.approvals;
    this.desktopSessionId = options.desktop_session_id ?? null;
    const resolved = new Map<string, ResolvedWorkspace>();
    for (const workspace of options.registry.workspaces()) {
      // `.native`, to match `realpathWithMissingTail` — which every candidate
      // path goes through. Containment is a segment-prefix comparison between
      // the two, so they have to be produced by the same resolver: on Windows
      // the JS and native implementations can disagree on junctions and 8.3
      // short names, and a root spelled one way never prefixes a candidate
      // spelled the other. That mismatch fails in both directions, denying a
      // contained path or admitting an escaped one depending on which way the
      // spellings fall.
      resolved.set(workspace.id, { id: workspace.id, root: fs.realpathSync.native(workspace.root) });
    }
    this.workspaces = resolved;
  }

  decide(input: PolicyInput): PolicyDecision {
    if (isTerminal(input.state)) return denial(ErrorCode.E_JOB_TERMINAL, 'The job is in a terminal state');
    try {
      assertDigest(input.envelope, input.envelope_digest);
    } catch (_error: unknown) {
      return denial(ErrorCode.E_ENVELOPE_DIGEST_MISMATCH, 'The envelope digest does not match');
    }
    try {
      assertNotExpired(input.envelope, input.now);
    } catch (_error: unknown) {
      return denial(ErrorCode.E_EXPIRED, 'The envelope has expired');
    }
    try {
      assertBudget(input.envelope, input.actions_used);
    } catch (_error: unknown) {
      return denial(ErrorCode.E_BUDGET_EXHAUSTED, 'The action budget is exhausted');
    }
    try {
      assertRetries(input.envelope, input.retries_used);
    } catch (_error: unknown) {
      return denial(ErrorCode.E_RETRIES_EXHAUSTED, 'The retry budget is exhausted');
    }

    const registered = this.registry.get(input.capability);
    if (registered === null) return denial(ErrorCode.E_NOT_REGISTERED, 'The capability is not registered');
    if (!input.envelope.allowed_capabilities.includes(input.capability)) {
      return denial(ErrorCode.E_CAP_NOT_ALLOWED, 'The capability is not allowed by the envelope');
    }
    if (containsForbidden(input.envelope, input.capability, input.arguments)) {
      return denial(ErrorCode.E_FORBIDDEN, 'The action contains a forbidden term');
    }
    if (input.workspace_id !== null && !input.envelope.allowed_workspaces.includes(input.workspace_id)) {
      return denial(ErrorCode.E_WORKSPACE_DENIED, 'The workspace is not allowed by the envelope');
    }
    if (input.paths.length > 0) {
      const workspace = input.workspace_id === null ? undefined : this.workspaces.get(input.workspace_id);
      if (workspace === undefined || input.paths.some((candidate) => !pathIsContained(workspace.root, candidate))) {
        return denial(ErrorCode.E_PATH_ESCAPE, 'A requested path is outside the workspace');
      }
    }
    try {
      this.registry.validateArguments(input.capability, input.arguments);
    } catch (_error: unknown) {
      return denial(ErrorCode.E_SCHEMA, 'The action arguments do not match the capability schema');
    }

    const action = registered.adapter.manifest.actions.find((entry) => entry.id === registered.actionId);
    const requiresApproval = this.approvalRequired.has(input.capability) || action?.always_requires_approval === true;
    if (requiresApproval) {
      if (input.approval_token === null) {
        return denial(ErrorCode.E_APPROVAL_REQUIRED, 'This action requires operator approval');
      }
      // The token used to be accepted for being a non-empty string, which meant
      // `approval_token: "yes"` cleared the gate — and no tool issued real ones,
      // so the string was all there ever was. It is now an approval request id
      // that has to name an operator decision covering this exact job,
      // capability and arguments, unexpired and unspent.
      //
      // Spending happens HERE rather than after the decision, because approval
      // is the last rule: nothing can deny after it, so a consumed approval is
      // always an allowed action. Splitting check from spend would let two
      // actions both verify before either spent, and one operator decision
      // would authorise two.
      if (this.approvals === undefined) {
        return denial(ErrorCode.E_APPROVAL_REQUIRED, 'This action requires operator approval');
      }
      const binding: ApprovalBinding = {
        job_id: input.envelope.job_id,
        capability: input.capability,
        arguments_digest: digest({ ...input.arguments }),
      };
      if (!this.approvals.consume(input.approval_token, binding, input.now)) {
        return denial(ErrorCode.E_APPROVAL_INVALID, 'The approval does not authorise this action');
      }
    }
    return { allow: true, reason: 'The action satisfies the policy controls' };
  }

  authorizeTargets(envelope: JobEnvelope, _capability: CapabilityId, targets: readonly ResolvedTarget[]): TargetDecisions {
    const decisions = new Map<string, 'allowed' | 'denied'>();
    for (const target of targets) {
      decisions.set(target.key, this.decideTarget(envelope, target));
    }
    return decisions;
  }

  /**
   * One resolved target's verdict (amendment A8). `app` targets fail closed on
   * three independent axes: the envelope must name the application, nothing
   * must forbid it, and the process must live in the node's own session.
   */
  private decideTarget(envelope: JobEnvelope, target: ResolvedTarget): 'allowed' | 'denied' {
    if (target.kind === 'capability') {
      // RR-03: a forbidden capability is denied even when the envelope allows
      // it. `forbidden` is a belt-and-braces layer over the allowlist, and it
      // wins when both speak.
      if (!envelope.allowed_capabilities.includes(target.capability)) return 'denied';
      return isForbidden(envelope, target.capability) ? 'denied' : 'allowed';
    }

    const identity = target.identity;

    // Rule 1: the envelope must name at least one matching application. Absent
    // means deny — a job that does not name its apps sees none of them.
    const apps = envelope.allowed_apps;
    if (apps === undefined || apps.length === 0) return 'denied';
    if (!apps.some((rule) => appRuleMatches(rule, identity))) return 'denied';

    // Rule 2: no forbidden term may match the FULL image path (every folder and
    // the file name), the product name, or the signer, using the same sequence
    // matching as `isForbidden`. This wins even when a rule matched — the
    // allowlist does not override `forbidden`. The whole path is checked, not
    // just the basename, because a job that forbids a directory must not let a
    // different executable in that directory slip through.
    if (isForbidden(envelope, identity.image_path)
      || isForbidden(envelope, identity.product_name ?? '')
      || isForbidden(envelope, identity.signer ?? '')) {
      return 'denied';
    }

    // Rule 3: the process session must equal the node's own. Absent/null
    // (unknown at construction) fails closed rather than trusting an unknown
    // session.
    if (this.desktopSessionId === null || identity.session_id !== this.desktopSessionId) {
      return 'denied';
    }

    return 'allowed';
  }
}

export function createPolicy(options: PolicyOptions): Policy {
  return new PolicyImpl(options);
}
