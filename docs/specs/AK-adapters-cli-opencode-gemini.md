# AK — OpenCode and Gemini CLI adapters

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

Two new session adapters through the existing `CliFraming` abstraction — the
part of `@toros/adapters-cli` that was built to vary while process
management, termination, limits, and cursors stay shared.

**OpenCode is the high-value one:** it already routes through OpenRouter on
this fleet, so one adapter makes every lane-mapped model (Grok, Kimi, GLM,
DeepSeek) dispatchable as a Toros worker under the same lifecycle, the same
policy, and the same Numbat visibility. Gemini CLI is a third first-class
agent and a useful bakeoff comparison point.

## The E-lesson governs the order of work

The original CLI adapter shipped against an imagined REPL protocol and every
`send` hung for 120 s against the real binaries
(`docs/finding-cli-adapter-one-shot.md`). So: **verification against the real
binary is the first deliverable, not the last.** Each adapter starts with a
finding document recording, against a pinned binary version:

1. the exact argv for a one-shot exchange with machine-parseable output;
2. how the CLI announces its conversation/session id, and the exact resume
   mechanism (`opencode run --session <id>` / whatever Gemini provides —
   verified, not assumed from docs);
3. which lines carry assistant text and how diagnostics interleave;
4. exit behavior on error, interrupt, and quota exhaustion.

Only then is the `CliFraming` written, mirroring the structure of
`CODEX_FRAMING`'s verified-on-date comments.

## Sandbox parity — the gating question

The codex adapter pins `-s workspace-write` + `approval_policy=never`;
the Claude adapter pins permission mode. Each new adapter must document what
it CAN pin, in the finding doc, and the registration follows the answer:

- A CLI with an enforceable write-scope or permission pin registers like
  codex, with the pin applied at init and operator args refused if they try
  to override it (existing rule, extended to the new flags).
- A CLI with **no** enforceable pin registers **read-only jobs only** at
  first: its capabilities go into the operator config's `approval_required`
  list, so every send crosses the approval gate until the operator has seen
  enough real receipts to decide otherwise. SPEC §8.1's ordinary-process
  honesty applies either way — this is policy layering, not confinement.

OpenCode's model selection is an operator config concern (`args: ["--model",
"openrouter/…"]` per lanes.toml); the adapter itself is model-agnostic and
refuses nothing except security-policy overrides.

## Deliverables

- `docs/finding-cli-opencode.md`, `docs/finding-cli-gemini.md` (verified
  behavior, pinned versions);
- two `CliFraming` implementations + registration entries;
- hermetic fixture tests per framing (the existing fixture pattern);
- real-binary test files that self-skip without binary/credentials (AJ rule);
- DEPLOY.md config examples for both, including a `runtime_profiles` entry if
  either needs one.

## Non-goals

- No third CLI protocol invented: if a binary cannot do one-shot +
  machine-parseable + resume, it does not get an adapter — it gets a finding
  doc saying why not, which is a complete and acceptable outcome for either
  candidate.
- No changes to the shared session machinery to accommodate a special case;
  a special case goes in the framing or not at all.

## Acceptance

1. Finding docs exist with pinned versions and verified argv, id, and resume
   behavior for both binaries (or a documented disqualification).
2. Hermetic suites pass for each shipped framing: exchange, resume,
   interrupt, stop, timeout, output limit, dispose.
3. Real-binary suite (operator machine): a two-exchange conversation where
   exchange two provably continues exchange one's context; raw JSONL audit
   files written per exchange; fail-closed on unwritable audit (existing
   invariant holds for new adapters).
4. Policy denies an opencode capability not in an envelope exactly as it does
   codex's — one acceptance case per new adapter through the live service.
5. A job using the OpenCode adapter with an OpenRouter lane model completes a
   bounded real task end-to-end, receipts intact.
6. Sandbox parity table appears in each finding doc; a CLI without a pin is
   registered gated as specified, verified by one denied-then-approved run.
