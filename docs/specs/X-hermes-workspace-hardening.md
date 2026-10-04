# X — Hermes workspace hardening

## Objective

Correct the defects in the W implementation before anything builds on it. No
new operator operation, no new capability, no change to the envelope or to the
policy surface. This slice is a correction pass, and it lands before Y.

## Defects and required behaviour

1. **Acceptance criteria are split on commas.** `lines()` in the cockpit splits
   on `,` as well as newlines, so a criterion containing a comma is silently
   cut into two and sealed that way. Acceptance criteria split on newlines
   only. Forbidden terms are single tokens and may keep comma separation, but
   the two must not share one helper.

2. **Expiry is computed from the operator's clock.** The cockpit sends an
   absolute `expires_at` derived from the browser's `Date.now()`. It must send
   `expires_in_hours` instead; Node Core converts it to `expires_at` against
   its own clock before sealing. The sealed envelope is unchanged in shape.

3. **Runs share one message array.** `createCoordinatorSupervisor` assigns
   `messages: existing?.messages ?? []`, so a new run aliases the previous
   run's array while the old process's stream handlers still hold it. Late
   output from a dying child appears in the new run under the new `run_id`.
   Each run owns its own array; carrying prior text forward, if wanted, is an
   explicit copy.

4. **Shutdown does not wait for children.** `stop` and `stopAll` call
   `child.kill()` and resolve immediately, and `stopAll` then clears the map,
   so `Core.stop()` returns with coordinators still alive. Both await the
   child's `exit`, with a bounded escalation to `SIGKILL` after a timeout.

5. **The coordinator entry path is guessed.** `main.ts` resolves
   `../../../coordinator/dist/src/main.js` relative to `import.meta.url`,
   which is correct only for the compiled layout. The path becomes an explicit
   `coordinator_entry` field in the node configuration with a documented
   default, and its existence is verified once at startup, not at first start.

6. **Error causes are discarded.** `handleOperator` replaces every non-Toros
   error with `E_ADAPTER_FAILURE: "Operator request failed"`, so a missing
   coordinator entry and an already-running coordinator are indistinguishable
   to the operator. The operator surface is authenticated and trusted: the
   originating message is preserved. The coordinator surface is unchanged and
   continues to disclose nothing.

7. **`waiting_for_approval` is a dead end.** The controls render neither Start
   nor Stop in that state, so once the approval expires and leaves the pending
   list, no control in the cockpit reaches the job. Every non-terminal job
   offers at least one control at all times.

8. **Message truncation splits characters.** `bounded()` cuts at a raw byte
   offset and can bisect a multi-byte character. Truncate on a character
   boundary.

9. **The runs map never evicts.** One entry per job for the process lifetime,
   each holding up to 200 messages of 8 KiB. Cap the number of retained
   finished runs. Y removes this structure entirely; until then it is bounded.

10. **One error slot for four pollers.** The Hermes workspace polls four
    operations every two seconds into a single `error` state, so one flaky
    call clears and re-sets the banner. Failures are tracked per source and
    the last good data is retained.

## Acceptance

1. An acceptance criterion containing a comma is sealed as one criterion.
2. A cockpit with a clock skewed by hours still creates a job that Node Core
   considers unexpired.
3. Output from a stopped coordinator cannot appear in a later run's messages.
4. `Core.stop()` resolves only after every coordinator process has exited.
5. A missing or misconfigured coordinator entry is reported at startup, and its
   message identifies the path.
6. An operator start failure names its cause; no operator-surface message reads
   `Operator request failed`.
7. No non-terminal job can reach a state with no available control.
8. Existing Node Core, coordinator, and cockpit tests continue to pass.
