import type { JsonValue } from './canonical.js';

/**
 * SPEC §4.3. Every adapter — CLI, desktop, and later transport — declares
 * exactly this and nothing more. An action absent from the manifest does not
 * exist as far as Node Core is concerned, which is what makes "the pilot
 * desktop app exposes only its registered schemas" checkable.
 */
export interface AdapterManifest {
  /** Stable adapter id, e.g. `claude`, `codex`, `excel`. */
  readonly id: string;
  /** Semver. Bump when an action schema changes shape. */
  readonly version: string;
  /** Platforms this adapter runs on. Node Core refuses to register a mismatch. */
  readonly platforms: readonly NodePlatform[];
  readonly actions: readonly ActionSchema[];
  /** Coarse permissions the adapter needs, for operator review and display. */
  readonly required_permissions: readonly Permission[];
  /**
   * Resource patterns the adapter may touch, as workspace-relative globs.
   * Advisory to the operator and enforced by policy; the adapter does not
   * enforce it on itself.
   */
  readonly allowed_resources: readonly string[];
  /** Default wall-clock ceiling for one action, milliseconds. */
  readonly default_timeout_ms: number;
  /** How cancellation reaches a running action. */
  readonly cancellation: CancellationBehavior;
  /**
   * Extra receipt fields this adapter contributes beyond the §8.3 minimum.
   * Declared so a reader knows what a receipt from this adapter can contain
   * without running it.
   */
  readonly receipt_fields: readonly string[];
}

export type NodePlatform = 'win32' | 'darwin' | 'linux';

export type Permission =
  | 'process.spawn'
  | 'fs.read'
  | 'fs.write'
  | 'app.automation'
  | 'network.loopback';

export type CancellationBehavior =
  /** The adapter stops promptly and leaves no partial artifact. */
  | 'graceful'
  /** The adapter is killed; partial artifacts may exist and are recorded. */
  | 'kill'
  /** The action cannot be interrupted once started; the timeout is the only bound. */
  | 'none';

/**
 * One invocable action. `input_schema` is a JSON Schema (draft 2020-12) subset
 * validated by the registry; arguments that fail it are denied with `E_SCHEMA`
 * before the adapter is ever reached.
 */
export interface ActionSchema {
  /** Action id, unique within the adapter. Fully qualified as `<adapter>.<action>`. */
  readonly id: string;
  /** One line, shown in the cockpit and in `list_capabilities()`. */
  readonly summary: string;
  readonly input_schema: JsonValue;
  /**
   * Argument names whose values are filesystem paths, and which policy must
   * therefore contain (SPEC §8.1). Required, and `[]` for actions that take
   * none — an author must decide rather than let a default decide for them.
   *
   * This exists because the alternative is guessing. Node Core previously
   * inferred paths by looking for a separator in the value, which silently
   * exempted `book.xlsx` and drive-relative `C:book.xlsx` from containment and
   * handed them straight to the adapter. Only the action author knows which of
   * its arguments name a file; nothing about the value reveals it.
   */
  readonly path_fields: readonly string[];
  /**
   * Whether this action mutates anything outside Toros' own state. Read-only
   * actions are exempt from the approval gate; mutating ones are eligible for it.
   */
  readonly mutates: boolean;
  /**
   * When true, the action always requires human approval regardless of
   * configuration (SPEC §8.1). Policy may add gates; it may not remove this one.
   */
  readonly always_requires_approval: boolean;
  /** Overrides the manifest default when present. */
  readonly timeout_ms?: number;
  /** Byte ceiling on captured output before `E_OUTPUT_LIMIT`. */
  readonly output_limit_bytes?: number;
}

/**
 * `<adapter>.<action>`. The string that appears in `allowed_capabilities`,
 * so its shape is contract, not convention.
 */
export type CapabilityId = string;

const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && CAPABILITY_ID_PATTERN.test(value);
}

export function capabilityId(adapterId: string, actionId: string): CapabilityId {
  const id = `${adapterId}.${actionId}`;
  if (!isCapabilityId(id)) {
    throw new TypeError(`capabilityId: "${id}" is not a valid capability id`);
  }
  return id;
}

/** A workspace the policy engine can contain paths within (SPEC §12.2). */
export interface Workspace {
  readonly id: string;
  /** Absolute, fully resolved root. Every job path must resolve inside it. */
  readonly root: string;
}
