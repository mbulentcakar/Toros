# Contributing

`AGENTS.md` is the rule set, and it is written for agents. This file is the
same discipline for a human, plus the things an agent already knows and a
newcomer does not.

Start with `node tools/orient.mjs`. It reports whether this machine can build
Toros, which agents and model endpoint it can reach, and a map of the packages
and capabilities — derived from the tree, so it does not go stale.

## Build and verify

```bash
npm install
npm run build
npm test
npm run typecheck
```

The cockpit is separate and needs Rust:

```bash
cd apps/cockpit && npm install && npm run test -- --run && npm run build
cd src-tauri && cargo test --locked
```

### Run it natively on Windows

Every adapter manifest declares `platforms: ['win32']`. The path-containment
code is Windows-specific by design — it reasons about drive-relative paths,
UNC prefixes, device names, and the disagreement between JavaScript's and the
OS's idea of a real path. A Linux run tests a platform Toros does not run on
and skips exactly the code most worth testing.

**A skipped test is a finding, not a pass.** This is not a slogan; it is the
lesson from suites that looked green because they had quietly stopped running.

### The tests that fail on a clean checkout

`packages/adapters-cli/test/real-cli.test.js` drives the *real* Claude and
Codex binaries and asserts loudly rather than skipping when they are absent or
misconfigured. On a machine without both installed and authenticated, three
assertions fail. That is deliberate — a suite that silently skips is worse —
but it means your first `npm test` may show failures that are not yours.

Run orientation to see whether it is your machine or your change: it reports
where each agent is and whether that executable is one the adapter accepts.
Spec `AJ` proposes making these self-skip loudly under CI.

## How a change is shaped

1. **Read `docs/SPEC.md`, especially Non-goals, first.** Toros is deliberately
   narrow. Most rejected ideas are rejected for being useful-later rather than
   needed-now.
2. **One accepted slice at a time.** Each slice has a specification in
   `docs/specs/` with numbered acceptance criteria; the implementation closes
   those and stops. If your change needs a new capability, integration, or
   surface, it needs a spec first — write the spec as its own change and let it
   be reviewed before the code exists.
3. **Do not touch `packages/contracts` as part of a slice.** The types, error
   codes, and canonicalisation are frozen on purpose; every package agrees
   because that file does not move underneath them.
4. **Record verification in the pull request.** The exact commands and their
   exact results, including what still fails and why. "Tests pass" is not a
   verification record.
5. **Implementation is not review.** An independent reviewer is required before
   acceptance. That applies to the author's own confidence most of all — the
   review history in `docs/reviews/` includes findings that were claims the
   code did not deliver, in a document that asserted them.

## Boundaries that are not negotiable

These come from `AGENTS.md` and from SPEC §8.1. A change that crosses one will
be declined however good it is otherwise.

- **Node Core is the authority. The model is never the policy boundary.** If a
  decision can be made deterministically, it is made deterministically, in
  `packages/policy`.
- **Capabilities are typed and allowlisted.** No unrestricted shell, no
  arbitrary filesystem browser, no arbitrary UI clicker. An adapter declares a
  manifest and does exactly what it declares.
- **GitHub stays canonical.** A checkpoint or a relay is not a commit, a
  review, an acceptance, or a deployment. Nothing in Toros commits, pushes,
  merges, deploys, or marks work accepted.
- **Workers pull.** No remote shell, in either direction.
- **Never commit a secret**, an environment file, a credential, a private
  dataset, or a raw model transcript. The relay refuses to build a capsule
  containing a secret-pattern match; do not make yourself the exception.
- **Stop means stop.** Completion, denial, exhaustion, or blocking terminates a
  run. It does not invite a creative reinterpretation of the objective.

## Licence

Toros is MIT licensed; see [LICENSE](LICENSE). Contributions arrive under the
same licence — opening a pull request is your agreement to that, and there is
no separate CLA to sign.

MIT is a deliberate choice for a repository like this one. Most of what is
here is not code you would import; it is a worked example of putting a
deterministic policy boundary between a model and a machine, with the
reasoning left in the comments. The point of publishing it is that someone
can take the parts that are useful, including into something commercial,
without asking. What MIT does not do is transfer any warranty: the file says
so in capitals, and §8.1 of the specification says the same thing in prose —
Toros bounds its own tool surface and does not confine the agents it
supervises. Read that before pointing it at anything you care about.

## Style

Match the surrounding code; it is consistent and the consistency is
load-bearing.

The one thing worth stating explicitly: **comments in this repository explain
why, not what.** Several of them record a specific defect that a previous
version had and the reason the current shape prevents it — the anchored
`.gitignore` rules, the native `realpath` in policy, the separated JSON parse
and normalise steps. Those comments are the only place that knowledge lives. If
you change such code, update the comment to be true rather than deleting it,
and if you fix a real defect, leave behind the sentence that stops it coming
back.
