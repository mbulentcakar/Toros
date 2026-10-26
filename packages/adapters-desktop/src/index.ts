/**
 * @toros/adapters-desktop — the read-only Windows desktop discovery adapter.
 *
 * Exposes two actions `desktop.state` and `desktop.inspect` that enumerate
 * top-level windows and inspect UIA accessibility trees. The PowerShell/UIA
 * layer is behind an injectable seam for testability.
 *
 * F3b adds the two-phase resolve (amendment A8): the desktop identity is the
 * OS-observed process identity (pid, creation time, image path + hash, signer,
 * session) rather than a spoofable basename, and the adapter resolves windows
 * as `app` targets that Core decides against the job envelope.
 *
 * Read-only, no mutation, no value extraction. Dependency: @toros/contracts only.
 */
export {
  createDesktopAdapter,
  type DesktopAdapterOptions,
  type RawControl,
  type RawWindow,
  type UiaProbe,
} from './adapter.js';
export { createPowerShellUiaProbe, parseIdentity } from './probe.js';