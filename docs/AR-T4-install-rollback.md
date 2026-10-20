# AR-T4 — install and rollback receipt for the desktop read-only discovery surface

**Status:** draft. The procedure-level detail in [DEPLOY.md](DEPLOY.md) and
[INSTALL.md](INSTALL.md) is the source until a native re-install on a fresh machine follows
only this document and it holds.

This covers the desktop read-only actions (`desktop.state`, `desktop.inspect`) behind the
`@toros/adapters-desktop` adapter, and their operator configuration.

## Config migration: `desktop.authorized_apps` is now a rule list (amendment A8, F3b)

The pilot adapter allowlisted applications by **basename** — a bare string process name like
`"EXCEL.EXE"`. That form is spoofable (a file can be renamed to match the name) and has been
replaced by the OS-observed identity bound from amendment A8.

The node config field `adapters.desktop.authorized_apps` is no longer an array of strings. It is
now an array of **application rules**, each exactly one of:

```jsonc
[
  { "image_sha256": "<64 lower-case hex characters>" },
  { "signer": "<Authenticode subject CN>", "product_name": "<version resource ProductName>", "original_filename": "<version resource OriginalFilename>" },
  { "image_path": "C:\\Absolute\\Path\\To\\app.exe" }
]
```

- `image_sha256` must be 64 lower-case hex characters (the SHA-256 of the image file).
- `signer` + `product_name` + `original_filename` must appear together, non-empty; `signer` and
  `product_name` at most 512 characters each, `original_filename` at most 260 characters with no
  path separators. `signer` and `product_name` match exactly and only against a **validly signed**
  image; `original_filename` matches case-insensitively (the version resource varies in case).
- `image_path` must be an absolute path, at most 512 characters, matched case-insensitively after
  separator normalisation. There is **no** basename rule anymore.

**A bare string entry makes Node Core refuse to start**, with a message naming the new format. If
an existing install carried basename entries, convert each one to the matching rule shape before
restarting. Example shapes only — use the hash, signer/product, or absolute path that this
operator actually wants to authorise, never a guessed value.

### Example: converting an old basename entry

```jsonc
// before (F2 / pilot)
"desktop": { "authorized_apps": ["EXCEL.EXE"] }

// after (F3b) — any one of these three shapes, not all three at once
"desktop": { "authorized_apps": [ { "image_sha256": "<64 hex>" } ] }
```

## Identity, session, and handles delivered by F3b

- **Identity:** each window's owning process is identified by pid, creation time, the canonical
  long image path (`QueryFullProcessImageName`), the image SHA-256, the Authenticode signature +
  subject CN, the version-resource ProductName, and the Windows session id — never by basename.
- **Session:** `desktop.state` input `session_scope` is now the enum `"interactive"`; any other
  value is schema-rejected. A locked or disconnected session returns
  `session: "unavailable"` with a `reason`.
- **Handles:** enumeration handles are per `(job_id, actor)`, single-use, and expire after 60 s.

## Rollback

The rollback for the desktop surface is the same as the node overall:
`Unregister-ScheduledTask -TaskName "Toros Node Core"`. Leave the database — it is the audit
trail. (See [INSTALL.md](INSTALL.md) "Rollback".)

Reverting the *config* (back to basename strings) is **not** a supported rollback direction:
the F3b build refuses to start on a basename entry. To move off the identity bound, restore the
previous adapter *release* rather than downgrading this one's config.