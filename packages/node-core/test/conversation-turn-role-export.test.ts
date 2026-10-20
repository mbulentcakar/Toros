/**
 * Type-level regression test for amendment A8 round 2 item 4: the frozen
 * contracts surface must keep exporting `ConversationTurnRole`. It was
 * accidentally removed from `@toros/contracts`'s entrypoint in 00ca084, which
 * broke every consumer that imported the type. This file imports it from the
 * package entrypoint (not from a relative source path), so a future removal is
 * a compile error, and pins the exact union with a compile-time `Equal` check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConversationTurnRole } from '@toros/contracts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

/**
 * Fails to compile when `ConversationTurnRole` is not exactly this union. The
 * alias is fully evaluated by `tsc` even though no value references it.
 */
type Expect<T extends true> = T;
type _ConversationTurnRoleIsExact =
  Expect<Equal<ConversationTurnRole, 'operator' | 'hermes' | 'system' | 'tool'>>;

test('ConversationTurnRole is exported from @toros/contracts', () => {
  const roles: readonly ConversationTurnRole[] = ['operator', 'hermes', 'system', 'tool'];
  assert.deepEqual([...roles], ['operator', 'hermes', 'system', 'tool']);
});