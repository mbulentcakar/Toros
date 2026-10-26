/**
 * @toros/adapters-machine — T2 read-only machine inventory adapter.
 *
 * Exposes one action `machine.inventory` that reports the readiness
 * of known adapters/tools on this node from a fixed taxonomy.
 *
 * Read-only, no mutation, no approval gate. Dependency: @toros/contracts only.
 */
export {
  createMachineAdapter,
  DEFAULT_MACHINE_PROBES,
  createPowerShellDriveTypes,
  powershellChildEnvironment,
  type AccessCheck,
  type DriveReaderSpawn,
  type DriveTypes,
  type MachineAdapterOptions,
  type MachineProbe,
} from './adapter.js';