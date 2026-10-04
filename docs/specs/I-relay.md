# Spec I — `@toros/relay`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements checkpoints and local relay capsules — **SPEC §7**, the §10 deliverables *"local
artifact/checkpoint store"* and *"local relay capsule creation and import"*, and the
secret-filtering control in **§8.1**.

## Objective

Two things a job can produce that outlive it: a **checkpoint** (a resumable local snapshot) and
a **relay capsule** (a portable archive of explicitly selected files for another node).

The rule underneath both, from SPEC §3.4 and the §2 non-goals: **a checkpoint or a relay is not
a commit, a review, an acceptance, or a deployment.** Nothing in this unit may touch git, push
anything, or move a work item to `accepted`.

## Allowed paths

```
packages/relay/package.json
packages/relay/tsconfig.json
packages/relay/src/**
packages/relay/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
docs/**
tools/**
```

Dependencies: `@toros/contracts` only. Archive format is **tar**, written by hand — no `tar`
package, no `archiver`, no zip library (00-CONTRACTS §3). Compression is `node:zlib` gzip.

## Public API — frozen

```ts
import type { Store, Workspace, JobRecord } from '@toros/contracts';

export interface RelayOptions {
  readonly store: Store;
  /** Where capsules and checkpoints are written. Inside the workspace root. */
  readonly output_dir: string;
  /** Bytes. A capsule larger than this is refused. */
  readonly max_capsule_bytes: number;
}

export interface Relay {
  createCheckpoint(jobId: string, description: string): Promise<CheckpointRef>;
  restoreCheckpoint(checkpointId: string): Promise<JobRecord>;
  createCapsule(input: CreateCapsuleInput): Promise<CapsuleRef>;
  importCapsule(path: string): Promise<CapsuleManifest>;
}

export interface CreateCapsuleInput {
  readonly job_id: string;
  /** Explicitly selected, workspace-relative. No globs — see below. */
  readonly selected_files: readonly string[];
  /** Artifact ids from the store. */
  readonly selected_outputs: readonly string[];
}

export function createRelay(options: RelayOptions): Relay;
```

## Checkpoints

A checkpoint records enough to resume: the job record, its envelope digest, session cursors,
artifact references, and the event chain head at that moment.

- It sets the work item's state to `checkpoint` — which is **not** terminal, and is resumable.
- It does **not** copy workspace files. A checkpoint is a state snapshot, not a backup; copying
  a workspace on every checkpoint makes the operation too expensive to use.
- `restoreCheckpoint` returns the job record and re-establishes cursors. It must work after a
  process restart, which is a §10 acceptance criterion — so everything it needs lives in the
  store, and nothing in memory.
- Record the chain head at checkpoint time. On restore, if the current chain head is not a
  descendant of the recorded one, that is a signal worth surfacing, not silently ignoring.

## Capsules

A capsule is a gzipped tar containing a manifest and the selected files.

### Explicit selection means explicit

`selected_files` is a list of literal, workspace-relative paths. **No globs, no directories, no
recursion.** SPEC §10's acceptance is *"a relay capsule contains only explicitly selected
files/outputs"*; a glob is by construction a selection the caller did not enumerate, and
`**/*` is one keystroke from shipping the whole workspace including its `.env`.

Reject with `E_SCHEMA`: a path containing `*` or `?`, an absolute path, a path containing `..`,
or a path naming a directory.

Every path is resolved and contained against the workspace root exactly as Spec D describes —
segment-wise, after realpath, case-insensitively on Windows. Containment is checked **here as
well as** in policy; this is deliberate defence in depth, because a capsule leaves the machine.

### Secret scanning is a refusal, not a filter

Scan every file's contents and every path before writing it. On a match, **refuse the whole
capsule** with `E_SECRET_DETECTED`, naming the file and the rule in `detail` — do not redact
the match and continue. A partially-redacted capsule looks safe and is not; the operator must
decide what to do.

Minimum rules, all case-insensitive:

- filenames: `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `id_rsa*`, `*.kdbx`, `credentials`
- contents: `-----BEGIN [A-Z ]*PRIVATE KEY-----`, `AKIA[0-9A-Z]{16}`, `gh[pousr]_[A-Za-z0-9]{36,}`,
  `sk-[A-Za-z0-9]{20,}`, `xox[baprs]-[A-Za-z0-9-]{10,}`, `AIza[0-9A-Za-z_-]{35}`,
  `-----BEGIN OPENSSH PRIVATE KEY-----`, and a generic
  `(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}`

Scan **bytes, not decoded text**, so a UTF-16 or Latin-1 file is not skipped by a decode error.
Skip files over 8 MiB for content scanning but still apply the filename rules, and record in the
manifest that they were not content-scanned — an unscanned file the manifest is silent about is
a claim the capsule cannot support.

### Manifest

Every capsule carries `manifest.json` at its root:

```jsonc
{
  "schema_version": 1,
  "capsule_id": "uuid",
  "job_id": "uuid",
  "envelope_digest": "hex",      // which envelope authorised this work
  "node_id": "string",
  "created_at": "RFC3339",
  "files": [{ "path": "...", "sha256": "hex", "bytes": 0, "content_scanned": true }],
  "artifacts": [{ "artifact_id": "...", "path": "...", "sha256": "hex", "bytes": 0 }],
  "state": "relay"
}
```

`state` is always `relay`. **Never `proposed`, never `accepted`.** A capsule is material for
another node to work on; it asserts nothing about acceptance, and §2 forbids marking work
accepted automatically.

### Import

`importCapsule` verifies before it trusts:

- every file's SHA-256 against the manifest — mismatch is `E_ENVELOPE_INVALID` naming the file;
- every path in the manifest is contained, checked again on this side. **Reject entries with
  absolute paths, `..`, or symlinks.** A tar entry that escapes its extraction root is the
  classic archive traversal, and "we wrote the archive" is not a defence when the point of a
  capsule is that it arrived from elsewhere;
- refuse a capsule whose uncompressed size exceeds `max_capsule_bytes`, checked **while
  streaming**, not from a header field a hostile archive controls.

Import returns the manifest. It does **not** write into a workspace, create a job, or set any
state — the operator decides what to do with a verified capsule.

## Acceptance tests

`packages/relay/test/`.

**Checkpoints**
1. `createCheckpoint sets state to checkpoint and returns a ref`
2. `checkpoint state is not terminal and the job can continue`
3. `restoreCheckpoint returns the job and cursors after a store reopen`
4. `checkpoint does not copy workspace files`
5. `restore surfaces a chain head that is not a descendant of the recorded one`

**Capsule creation**
6. `creates a capsule containing exactly the selected files`
7. `rejects a glob in selected_files with E_SCHEMA`
8. `rejects an absolute path`
9. `rejects a path containing ..`
10. `rejects a directory`
11. `refuses the whole capsule on a secret match with E_SECRET_DETECTED`
12. `refuses on a .env filename even when the contents are innocuous`
13. `detects a private key block in a UTF-16 encoded file`
14. `marks a file over 8 MiB as content_scanned false in the manifest`
15. `manifest state is relay and never proposed or accepted`
16. `manifest records the envelope digest`

**Import**
17. `imports a capsule this node created and returns its manifest`
18. `rejects a capsule whose file hash does not match the manifest`
19. `rejects a tar entry with an absolute path`
20. `rejects a tar entry containing ..`
21. `rejects a tar entry that is a symlink`
22. `refuses a capsule exceeding max_capsule_bytes while streaming`
23. `import does not write into a workspace or create a job`

**The standing rule**
24. `no code path in this package invokes git`

Tests 19-21 need hand-built malicious tar fixtures. Write the bytes directly — this is why the
tar writer is hand-rolled and small enough to do that against.

## Verification

```
npx tsc --build packages/relay
node --test packages/relay/dist/test/*.test.js
```

Clean, zero skips.

## Out of scope

Network transport, Tailscale, Hetzner, and the exchange service — all Phase 2. This unit
writes and reads a file on the local disk. Nothing in it opens a socket.
