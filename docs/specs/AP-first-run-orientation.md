# AP — First-run orientation

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-09-03

## Objective

Toros is heading for a public repository. Today the path from `git clone` to
"I understand what this is and whether it can run here" is a 200-line
Windows-specific deployment document, a 450-line status log, forty specs, and
thirteen packages. Nothing in the repository can answer, mechanically, the
three questions every newcomer asks first:

1. **Can I build this?** — versions, toolchains, what is optional.
2. **What will actually work on my machine?** — which CLI agents are installed,
   which adapters can therefore register, which model endpoint is configured.
3. **What *is* this?** — what each package does and which spec governs it.

The evidence that this is a real gap rather than a documentation preference is
that the authoring machine itself cannot answer question 2. On 2026-09-03,
`%LOCALAPPDATA%\Toros\config.json` did not exist on the machine whose paths are
hard-coded into `docs/DEPLOY.md` as the installed configuration, and nothing
reported that fact. The deployment document describes a machine, not a check.

Add `npm run orient`: one read-only command that reports the environment, the
agents and models this host can actually reach, the validity of the local
configuration, and a derived map of the codebase.

## Non-goals

- **Not an installer.** It does not download, install, elevate, or configure
  anything. `--init-config` writes exactly one file, only when asked, and only
  when that file does not exist.
- **Not a replacement for `docs/DEPLOY.md`.** Deployment stays the operator
  procedure; orientation reports what that procedure would find.
- **Not a health check of a running node.** It never authenticates to Node
  Core and never reads a job, receipt, conversation, or event. Those are the
  operator surface and require the operator credential; an orientation tool
  that held that credential would be a second, weaker path to the same data.

  **Amended 2026-09-03.** This non-goal originally said orientation does not
  health-check *anything*, and that was wrong in a way the tool itself
  demonstrated: it reported `ok  claude — usable` and `No blockers` on a
  machine where the Claude adapter could not complete a single exchange. It
  had checked that a binary existed and was the right kind of file, which is
  not the same question as whether the thing works. Orientation still does not
  health-check Node Core; it now verifies *adapters*, on request, through
  `--verify-agents`. See §"Verifying an agent" below.
- **Not a network tool by default.** One flag, `--probe-models`, makes exactly
  one outbound request. Without it the tool never opens a socket, with the one
  exception of `--verify-agents`, whose whole purpose is to make an agent do a
  round trip.

- **Not an agent runner by default.** `--verify-agents` is the only path that
  executes an agent rather than merely resolving it, and it is opt-in for that
  reason.
- **No new dependency.** It must run on a fresh clone before `npm install`.

## Constraints that shape the design

### It runs before anything is built

The first thing a newcomer does is clone. So `tools/orient.mjs` is plain ESM
with no imports outside `node:`, no build step, and no workspace membership.
`node tools/orient.mjs` works on a tree with no `node_modules/` and no
`dist/`. Sections that genuinely need built output — the capability inventory —
report that they need `npm run build` rather than failing.

### The interesting failure is a `.cmd` shim, not a missing binary

`CliSessionAdapter.init` refuses any executable ending `.cmd` or `.bat`, and
anything that is not `.exe` unless it is the Node runtime itself. This is
correct and deliberate: on Windows a `.cmd` is interpreted by `cmd.exe`, where
argument-list quoting is not a security boundary.

But npm installs `claude` on Windows *as* `%APPDATA%\npm\claude.cmd`. So the
binary a newcomer finds on `PATH`, verifies with `claude --version`, and puts
in their configuration is precisely the one Node Core will refuse — and the
refusal happens at adapter initialisation, inside a service registered as a
scheduled task, where nobody is reading the error. The real target is the
sibling `node_modules\@anthropic-ai\claude-code\bin\claude.exe`.

Reporting *this* is most of the tool's value. For every agent family it
resolves what is on `PATH`, says whether that path is usable by the adapter,
and when it is not, looks for the real executable next to the shim and prints
the configuration line to use.

### Secrets are reported by shape, never by value

The tool reads two files that contain credentials: `config.json` (`token`,
`operator_token`) and `coordinator.json` (`api_key`). It reports presence,
length, and whether the two Node Core tokens differ — the properties Node Core
itself validates — and never the value, in any mode, including `--json`. There
is no flag that reveals one. A tool people paste the output of into an issue
must not be capable of leaking a credential.

## Behaviour

```text
node tools/orient.mjs [--json] [--check] [--init-config [path]] [--probe-models]
```

Default output is a human-readable report on stdout. Every finding carries one
of three levels:

| Level | Meaning |
| --- | --- |
| `ok` | Present and usable. |
| `warn` | Optional, or usable with a caveat that is stated. |
| `block` | Something required is missing or wrong; the reason names the fix. |

`--check` exits `1` when any `block` finding exists and `0` otherwise, so CI
and a first-run script can use the same command. Without it the exit code is
`0` unless the tool itself failed.

`--json` prints the same findings as a machine-readable document. It is the
same data, not a superset: nothing is available in JSON that the report hides.

### 1. Environment

Node version against `engines.node`; npm; git; the platform, with an explicit
note when it is not `win32` (every adapter manifest declares
`platforms: ['win32']`, so a non-Windows host can build and test the packages
but cannot register an adapter); `cargo` and `rustc` for the cockpit, reported
as `warn` when absent because the cockpit is optional to a packages-only
contributor; and whether `dist/` exists.

### 2. Agents and models

For each known CLI family — currently `claude` and `codex` — resolve the
executable on `PATH`, classify it, and read its version by running it with a
**fixed literal argument vector** (`--version`), never a shell, with a timeout
and an output cap. The binary name comes from a hard-coded allowlist; nothing
from the configuration, the environment, or `argv` can select what is executed.

Classification is one of: `usable` (a real `.exe`), `shim` (a `.cmd`/`.bat`
that the adapter will refuse — with the real executable's path when it can be
found beside it), `absent`, or `unknown-platform`.

The desktop pilot adapter's target (Excel) and the Chrome worker extension
directory are reported the same way: present, absent, or configured-but-missing.

Models: the configured `model` and `base_url` are read from `coordinator.json`
and reported. With `--probe-models` — and only then — the tool issues one
`GET {base_url}/models` with the configured key and lists the model ids the
provider returns. The key is used as an `Authorization` header and is never
printed, never logged, and never placed in a URL. Any failure is reported as
its status code and nothing else, because a provider error body can quote the
credential back.

### 3. Configuration

`config.json` is validated against the rules Node Core enforces at startup, so
that a configuration which passes here starts a node:

- the file parses, tolerating a UTF-8 BOM as `main.ts` does;
- `token` is a string of at least 32 characters;
- `workspaces` is a non-empty array whose roots are absolute and exist;
- `operator_token`, when present, is at least 32 characters and **differs from
  `token`** — and is *required* when `approval_required` is non-empty;
- each configured adapter executable exists and satisfies the `.exe` rule;
- `coordinator_entry`, when set, exists;
- `db_path`'s parent directory exists.

Each failure is a `block` naming the field and the fix. A missing file is a
`warn`, not a `block`: not having configured a node yet is the normal state of
a fresh clone, and the suggested next step is `--init-config`.

`--init-config` writes a starter `config.json` with two independently generated
64-character hex tokens from `crypto.randomBytes(32)`, a `sandbox` workspace,
and no adapters. It **refuses to overwrite an existing file** — there is no
`--force`, because the file it would destroy contains credentials that exist
nowhere else. On POSIX it is created mode `0600`; on Windows, where mode bits
are not the access-control mechanism, the report says explicitly that the file
inherits directory permissions and where it is.

### 4. Codebase map

Derived from the tree at every run, so it cannot drift:

- each workspace package, its `description`, source and test file counts;
- the `docs/specs/` index by letter with each spec's title and status line;
- the capability inventory — adapter id, version, and action ids — read from
  the built adapter manifests when `dist/` exists, by constructing each adapter
  with inert placeholder options and reading `.manifest`. The constructors do
  no I/O and spawn nothing; `init()`, which does, is never called. When `dist/`
  is absent the section says so and names the build command.

A package with no `description` is a `warn`: the map is only as good as the
manifest it is derived from, and the check is what keeps it honest.

## Verifying an agent

`--verify-agents` drives each agent through **one real exchange** and reports
what happened. It is the rung the first version was missing: presence, then
shape, then *function*.

For each family it takes the executable a run would actually use — what the
operator configured, or, when nothing is configured yet, the usable executable
resolved from `PATH` — constructs the adapter, opens a session, sends one fixed
prompt, and reads to a terminal state.

Bounded, because this is the one thing here that runs someone else's program:

- the sandbox is pinned `read-only`, so Claude gets `--permission-mode plan`
  and codex gets `-s read-only`;
- the workspace is a fresh temporary directory, removed afterwards;
- the prompt is a **fixed literal** — nothing from configuration, environment,
  or argv reaches it;
- the exchange has a hard deadline, after which the child is terminated;
- the session is stopped and the adapter disposed on every path, including
  failure.

**The outcomes are reported separately because they have different fixes:**

| Outcome | Means | What to do |
| --- | --- | --- |
| completed an exchange | this agent can do work here | nothing |
| could not start | the executable is wrong, or the adapter refused it | fix the configured path |
| starts, but the turn never returns | the binary runs and its credentials are found; the model turn is not coming back | a runtime or account condition, not a Toros configuration |
| exchange failed | the agent ran and the exchange ended badly | read the reported error code |

Collapsing the middle two would be the whole mistake again: "it does not work"
sends an operator to their config file, and on 2026-09-03 that would have been
the wrong file entirely.

## Reporting what the real-binary suites will do

Cheap and read-only, so it runs by default. For each real-binary suite,
orientation reports the executable it will use and whether the suite will
**RUN** or **SKIP** on this machine, with the reason.

A skipped suite is invisible in a green summary. The codex suite skipped for
weeks because the path it named had stopped existing, while `docs/STATUS.md`
attributed the failures to an exhausted provider quota — the exact
green-looking-skip this reports.

Both the paths and the preflight rules are imported from the suites' own
modules (`real-binary-paths.ts`, `real-test-preflight.ts`), so this cannot
drift from what the suites actually do. Those paths previously lived as
literals inside two test files, which is how they came to disagree with
reality without anyone noticing.

## Acceptance criteria

1. `node tools/orient.mjs` completes on a tree with no `node_modules/` and no
   `dist/`, exits `0`, and reports the missing build rather than failing.
2. `--json` emits parseable JSON whose findings match the text report.
3. No credential value appears in any output mode. A test constructs a config
   holding known token values and asserts neither appears in the report or the
   JSON.
4. A `.cmd` on `PATH` is classified `shim`, not `usable`, and the finding names
   the adapter rule it violates.
5. Executed argument vectors are fixed literals; a test asserts that a
   configuration or environment value cannot reach the argument list.
6. `--init-config` refuses an existing file, and the two generated tokens
   differ.
7. The config validator accepts a configuration Node Core accepts and rejects
   one it rejects, for each rule listed above.
8. `--check` exits `1` when a `block` finding exists.
9. Without `--probe-models` the tool makes no outbound request.
10. The codebase map lists every workspace package present in the tree.
11. Without `--verify-agents`, no agent process is started.
12. `--verify-agents` distinguishes "could not start" from "started but the
    turn never returned", because those have different fixes.
13. The verification prompt is a source literal; a test asserts that no
    configuration or environment value can reach it.
14. Verification removes its temporary workspace and disposes the adapter on
    every path, including failure.
15. The real-binary suite report agrees with the suites themselves, because it
    imports their paths and their preflight rather than restating either.
