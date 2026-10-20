/**
 * @toros/contracts — the frozen surface every Toros package codes against.
 *
 * This package is authored once and reviewed as a whole. Implementation slices
 * must not edit it: a unit that needs a change here has found a spec gap, and
 * the change belongs in its own reviewed commit, not folded into a feature.
 *
 * It holds types, error codes, and the two pure functions whose byte-level
 * behaviour several packages must agree on (canonicalization and hashing).
 * It holds no I/O, no state, and no policy.
 */

export {
  canonicalize,
  chainHash,
  digest,
  GENESIS_HASH,
  type JsonValue,
} from './canonical.js';

export { ErrorCode, isErrorCode, TorosError } from './errors.js';

export {
  isTerminal,
  TERMINAL_STATES,
  WorkItemState,
  type CoordinatorAction,
  type CoordinatorResponse,
  type JobEnvelope,
  type AppRule,
  type SealedEnvelope,
} from './envelope.js';

export {
  capabilityId,
  isCapabilityId,
  type ActionSchema,
  type AdapterManifest,
  type CancellationBehavior,
  type CapabilityId,
  type NodePlatform,
  type Permission,
  type Workspace,
} from './capability.js';

export {
  type ActionOutcome,
  type ChainHead,
  type ChainVerification,
  type EventKind,
  type EventRow,
  type PolicyDecision,
  type Receipt,
} from './receipt.js';

export {
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AppendEventInput,
  type AppendTurnInput,
  type ApprovalBinding,
  type ApprovalVerifier,
  type ArtifactRecord,
  type CapabilityRegistry,
  type ConversationRecord,
  type ModelUsageRecord,
  type ConversationTurn,
  type ConversationTurnChannel,
  type CorrelationConfidence,
  type CorrelationRetraction,
  type AppIdentity,
  type FindingRecord,
  type JobRecord,
  type ResolvedTarget,
  type SecurityObserver,
  type SessionAdapter,
  type SessionRecord,
  type Store,
  type TargetDecisions,
  type TargetResolver,
  type ConversationTurnRole,
} from './ports.js';
