# Security policy

## Reporting a vulnerability

Please report privately, through GitHub's private vulnerability reporting on
this repository — the **Security** tab, then **Report a vulnerability**. That
opens a channel visible only to the maintainer.

Please do not open a public issue for a vulnerability, and please do not
demonstrate one against a machine you do not own.

A useful report says what an attacker can reach that they should not, and how
you established it. A proof of concept is welcome; so is a precise description
of the reasoning. Expect an acknowledgement within a week. This is a
single-maintainer project with no service-level commitment, and there is no
bounty.

## Scope

Toros is a **local, single-operator control plane**. Node Core binds
`127.0.0.1` only, and nothing in this repository operates a public service.
There is no production deployment to attack and no multi-tenant boundary to
cross.

The interesting attack surface is therefore internal, and the trust boundaries
are worth stating plainly because they decide what counts as a vulnerability.

### In scope

- **The coordinator is untrusted.** It holds a bearer credential for the tool
  surface, and it is driven by a model whose context includes attacker-
  influenced text. Anything a coordinator credential can reach that policy
  should have denied is in scope: a capability outside the envelope's
  allowlist, a path outside the workspace, a budget or retry ceiling that does
  not hold, an approval that is granted, replayed, or bypassed.
- **The audit must be true.** A way to make a receipt, an event, or the
  operator's approval screen record something other than what executed is in
  scope even when the action itself was permitted.
- **The operator credential must stay separate.** Any path by which the
  coordinator — or a CLI worker, or the Chrome worker — obtains the operator
  bearer, records an approval decision, or attributes its own action to the
  human at the console.
- **Credentials must not leak into model context or into durable state.**
  Node Core's tokens and a run credential are supposed to be unreachable by a
  worker and redacted out of anything persisted.
- **Adapter confinement.** A registered action doing more than its manifest
  declares: the Chrome worker reaching a domain outside the allowlist, the CLI
  adapter's pinned sandbox or permission mode being overridable by
  configuration, the Excel adapter reaching a file outside the workspace, a
  stage-graph handoff carrying a symlink or escaping its caps.

### Out of scope

- **A compromised operator account.** Node Core runs as the operator and reads
  its credentials from a file in that account's profile. Anything that already
  requires write access to that profile, or to a `PATH` directory, is a
  consequence of the compromise rather than a finding — though see
  `docs/reviews/` for cases where we tighten such paths anyway on principle.
- **Confining the worker.** Toros bounds *its own* tool surface. It does not
  sandbox the CLI agents it supervises: the read-only pinning of Claude is
  Claude's permission mode, which is policy, not OS confinement. SPEC §8.1
  states this. A worker doing something Toros never authorised because the
  worker chose to is a limitation we have written down, not a vulnerability.
- **A model saying something wrong or being persuaded to propose something
  bad.** By design a proposal reaches a human before anything is sealed. A
  *deceptive* proposal that the interface presents in a way a careful operator
  would misread is in scope; a bad idea that the operator declines is not.
- **Denial of service against the local loopback socket** by a caller that
  already holds a local credential.
- **Numbat**, which is an external monitor-only component.
- Findings from an automated scanner with no reachable path described.

## What is already known

`docs/reviews/` holds security reviews with their findings and status. Please
check it before reporting — a report that engages with a known limitation and
shows it is worse than recorded is much more valuable than one that rediscovers
it.
