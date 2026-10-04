/**
 * @toros/adapters-desktop — T3 read-only Windows UIA desktop discovery adapter.
 *
 * Exposes two actions `desktop.state` and `desktop.inspect` that enumerate
 * top-level windows and inspect UIA accessibility trees. The PowerShell/UIA
 * layer is behind an injectable seam for testability.
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
export { createPowerShellUiaProbe } from './probe.js';