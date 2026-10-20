import type { Adapter, CapabilityId, SecurityObserver, Workspace } from '@toros/contracts';

import type { CoordinatorControl } from './coordinator-supervisor.js';
import { Core } from './core.js';

/**
 * What a correlating observer needs from Node Core (SPEC §8.2 routes 1 and 3).
 *
 * Both are synchronous because the correlator is, so both are answered from an
 * in-memory index rather than the store.
 *
 * The index holds sessions this process created, and that is the whole truth
 * available rather than a shortcut: a CLI child does not survive a Node Core
 * restart, so a correlation id naming a session from a previous run names a
 * directory with no live process behind it. Attributing a record to it would be
 * a wrong answer, not a missing one. Stopped sessions DO stay resolvable for
 * the life of the process, because the records tail asynchronously and one may
 * legitimately arrive describing work the session did before it ended.
 */
export interface ObserverDeps {
  /** A correlation id — the last segment of an observed project path. */
  readonly resolveSession: (correlationId: string) => string | null;
  readonly jobForSession: (sessionId: string) => string | null;
}

export interface NodeCoreOptions {
  readonly node_id: string;
  readonly db_path: string;
  readonly workspaces: readonly Workspace[];
  /** Loopback only. Binding anything else is a defect. */
  readonly port: number;
  /** Bearer token. Read from config by the caller, never generated here. */
  readonly token: string;
  readonly adapters: readonly Adapter[];
  /**
   * An observer, or a factory given the correlation lookups Node Core owns.
   *
   * The factory form exists because a correlating observer cannot be built
   * before the thing it correlates against. `main.ts` had to construct one at
   * startup and passed `resolveSession: () => null` to get past that, which
   * left routes 1 and 3 — the ones five review rounds went into — inert in the
   * deployed service while every unit test exercised them with a real resolver.
   */
  readonly observer: SecurityObserver | ((deps: ObserverDeps) => SecurityObserver) | null;
  readonly approval_required: readonly CapabilityId[];
  /**
   * The Windows session id Node Core runs in (amendment A8). Passed through to
   * policy so `authorizeTargets` can require a resolved app to live in the same
   * session. Absent or null means every `app` target is denied (fail closed).
   * F3a does not compute it: `main.ts` leaves it unset, which is safe because no
   * adapter has a resolver until F3b resolves it on Windows at startup.
   */
  readonly desktop_session_id?: number | null;
  /** Validated operator approval lifetime in minutes. Defaults to 60. */
  readonly approval_ttl_minutes?: number;
  /**
   * Bearer for the operator surface, which issues approvals. MUST differ from
   * `token`: the coordinator holds `token`, and a gate the gated party can open
   * is not a gate. Node Core refuses to start if any capability requires
   * approval and this is absent or equal to `token` — a gate that can never be
   * satisfied is a silently broken node, and one the coordinator can satisfy
   * itself is worse.
   */
  readonly operator_token?: string;
  /** Operator-started one-job coordinator processes. Absent in isolated tests. */
  readonly coordinator?: CoordinatorControl;
}

export interface NodeCore {
  start(): Promise<{ readonly port: number; readonly registered_capabilities: readonly string[] }>;
  stop(): Promise<void>;
}

export function createNodeCore(options: NodeCoreOptions): NodeCore { return new Core(options); }
export type { CoordinatorControl, CoordinatorMessage, CoordinatorRun, CoordinatorRunState, CoordinatorStartInput } from './coordinator-supervisor.js';
