# Toros Agent Rules

## Scope discipline

- Read `docs/SPEC.md`, especially **Non-goals**, before changing code.
- Implement one accepted phase slice at a time.
- Do not add capabilities, integrations, agents, or workflows merely because they may be useful later.
- Stop when the current acceptance criteria pass.
- The coordinator coordinates; specialist workers implement.

## Safety boundaries

- The Node Core is the authority. The model is never the policy boundary.
- Expose typed, allowlisted capabilities; do not expose an unrestricted shell or arbitrary filesystem access.
- Keep GitHub canonical. A checkpoint or relay is not a commit, review, acceptance, or deployment.
- Numbat starts monitor-only and does not replace policy, isolation, approvals, or receipts.
- Workers pull jobs. Do not add remote shell access.
- Never commit secrets, environment files, credentials, private datasets, or raw model transcripts.
- Hetzner changes and deployment remain outside this repository's implementation authority unless the human operator explicitly authorizes them in the current session.

## Delivery

- Keep changes bounded to a written task and objective acceptance checks.
- Record verification commands and results in the PR.
- Implementation is not final review; require an independent reviewer before acceptance.
