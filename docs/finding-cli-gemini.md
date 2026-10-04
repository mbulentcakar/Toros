# Finding: Antigravity CLI as the Gemini worker

Verified on Windows/WSL on 2026-09-04 against Antigravity CLI 1.1.22.

Toros launches `C:\Windows\System32\wsl.exe -e /snap/bin/agy`. The verified
non-interactive protocol is one NDJSON user event on stdin with
`--input-format stream-json --output-format stream-json`. The `init` event
carries `conversation_id`; a later `result.result.response` carries the final
assistant text. A second process resumes the same context with
`--conversation <conversation_id>`.

The stdin shape is:

```json
{"event":"user","message":{"role":"user","content":"..."}}
```

Toros pins `--sandbox` for terminal restrictions and pins `--mode plan` for a
read-only worker or `--mode accept-edits` for a workspace-writing worker.
Operator arguments cannot override either setting. The sandbox is implemented
inside the WSL-hosted CLI; Toros policy still remains the authority described
by SPEC §8.1.

Live verification covered a fresh exchange, extraction of `conversation_id`,
and a resumed exchange that recalled the first response.

## Deployment prerequisite

The configured WSL distribution must expose Antigravity at `/snap/bin/agy`.
Revalidation on this branch found that path absent in the current Ubuntu
distribution, so the opt-in real test fails closed before a worker session can
start. Keep the adapter WSL-backed as directed; restore or install the WSL
executable before enabling this worker in live configuration.

## Addendum — Antigravity 1.2.7 headless permissions, JanBot, 2026-09-21

On JanBot the WSL executable is `~/.local/bin/agy` (a user install, not the snap);
the adapter's `launcher_args` carry that path. Version 1.2.7 changed headless permissions:
`--mode plan` no longer grants reads, and a tool that would prompt is auto-denied — which
**ends the turn with an empty `response`** and the denial listed under `denied_actions`. The
first real job on this node read nothing: `read_file` on its own `BRIEF.md` in the working
directory was denied.

Grants live in the CLI's `~/.gemini/antigravity-cli/settings.json` inside WSL, under
`permissions.allow`. Verified rule forms: `read_file(<directory>)` is a directory-prefix grant;
glob forms (`/*`, `/**`) do not match; a bare `read_file` grants nothing. The grant installed on
JanBot is exactly one rule, `read_file(/mnt/f/Code/_toros/workspaces)`, and it is a deployment
prerequisite for the gemini adapter, recorded here because it lives outside the repository.

**Do not grant `command(...)` rules to this worker.** Under `--sandbox` the CLI's terminal runs
in its own scratch directory (`pwd` → `~/.gemini/antigravity-cli/scratch`), not the workspace,
while `view_file` uses real paths. With `ls`/`find`/`cat` granted, the model searched from the
scratch directory across the filesystem and listed a sibling session's `BRIEF.md` — a shell it
cannot orient is worse than no shell. With reads only, `write_to_file` reached only the CLI's
own plan file, a `touch` was denied, and a read of `~/.bash_history` outside the prefix was
denied.

The remaining failure mode is orientation: the model sometimes assumes the scratch directory is
its workspace (it asked `view_file` for `.../scratch/BRIEF.md`, then fell back to a shell `find`
and died on the denial). **A brief for this worker must name the absolute WSL workspace path
(`/mnt/f/Code/_toros/workspaces/<session>`) and say not to use shell commands.** With that, a
review job through the live node completed in ten `view_file` calls — it resolved the git HEAD
by reading `.git/HEAD` and `refs/heads/*` rather than running git — with no denial.
