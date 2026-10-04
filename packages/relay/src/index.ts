/**
 * @toros/relay — checkpoints and relay capsules (SPEC I-relay).
 *
 * Public surface. See `./relay.ts` for the implementation and the constraints
 * it enforces.
 */

export { createRelay } from './relay.js';
export type {
  Relay,
  RelayOptions,
  CreateCapsuleInput,
} from './relay.js';
export type {
  CheckpointRef,
  CapsuleRef,
  CapsuleManifest,
  CapsuleFile,
  CapsuleArtifact,
} from './manifest.js';
