import type { Adapter } from '@toros/contracts';

import { createMachineAdapter, type MachineAdapterOptions } from '../src/adapter.js';

/**
 * Builds an adapter for a unit test.
 *
 * Every unit test must inject `driveTypes` so a `node --test` run never spawns
 * the production PowerShell reader (AR-F5 round 2). An adapter built without
 * it falls back to `createPowerShellDriveTypes`, which starts a child process —
 * exactly what burned the CI `Root` job at 5,007 ms. This guard throws instead
 * of letting that regress silently; the production reader is exercised only by
 * the `TOROS_REAL_TESTS=1`-gated suite, which builds directly through
 * `createMachineAdapter`.
 */
export function makeTestAdapter(options: MachineAdapterOptions): Adapter {
  if (options.driveTypes === undefined) {
    throw new Error(
      'unit tests must inject driveTypes: createMachineAdapter without it falls back to the production PowerShell reader',
    );
  }
  return createMachineAdapter(options);
}