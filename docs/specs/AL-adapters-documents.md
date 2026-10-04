# AL — Document adapters: Word and Pandoc

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

Two capability adapters at tiers 1–2 of the §4.3 preference order, mirroring
the Excel adapter's shape: a small set of registered actions, schema-validated
arguments, declared `path_fields` for containment, declared `receipt_fields`,
and nothing generic.

## Word (`word`) — tier 1, COM

Same machinery as the Excel adapter (`@toros/adapters-app`), same host
application family, registered actions and nothing else:

- `word.inspect_document` — metadata: title, section/heading outline,
  page and word counts, tracked-changes/comments presence;
- `word.read_section` — text of one section or heading range, bounded bytes;
- `word.write_section` — replace or append content under one heading;
  **`always_requires_approval: true`** in the manifest — it mutates a
  document, and the Excel precedent (`write_range`) already draws this line;
- `word.export_pdf` — export to a contained output path.

All document and output paths are `path_fields`, resolved and contained by
policy exactly as Excel's are. Documents with macros (`.docm`, `.dotm`) are
refused at inspect — opening one under COM automation can execute code, and
a document adapter must not be a macro launcher.

## Pandoc (`pandoc`) — tier 2, document conversion

One action:

- `pandoc.convert` — `{ input_path, output_path, to }` where `to` is from an
  allowlisted format set (`markdown`, `html`, `docx`, `pdf`, `plain`,
  `gfm`). Input format is inferred by pandoc; both paths are `path_fields`.

**The security boundary is the argv, stated plainly:** pandoc filters and
templates are code execution (`--filter`, `--lua-filter`, custom
`--template`, `--pdf-engine-opt`). The adapter builds the argv itself from
the three validated arguments plus pinned safety flags — including
`--sandbox` — and there is **no pass-through argument channel at all**. This
is deliberately stricter than the CLI adapters' "operator args minus
security switches": conversion has no legitimate need for operator argv, so
the channel does not exist rather than being filtered.

The pandoc binary path and version are operator config; the adapter refuses
to register if the binary is absent (same fail-at-registration behavior the
registry already gives a bad manifest).

## Non-goals

- No Outlook, no PowerPoint, no mail-adjacent anything — each would be its
  own spec with its own risk section.
- No batch conversion, no directory walking: one document per action, budget
  spent per document, receipts per document.
- No template management. If templated output is ever needed, templates
  become registered read-only resources in a future spec, not arguments.

## Acceptance

1. Word: inspect → read → approved write → export round-trip on a fixture
   document, through the live service, with receipts and artifacts; an
   unapproved `write_section` denies `E_APPROVAL_REQUIRED`.
2. Word: a `.docm` fixture is refused at inspect with a distinct error; a
   path outside the workspace denies `E_PATH_ESCAPE` (both containment
   directions, matching the Excel tests).
3. Pandoc: markdown → docx and markdown → pdf fixtures convert; output
   hashes recorded in receipts; a `to` value outside the allowlist fails
   schema validation.
4. Pandoc: a malicious "argument" like `--lua-filter=x.lua` supplied inside
   `to` or a path fails schema validation and never reaches an argv — one
   test constructs the attempt.
5. Both adapters expose `receipt_fields` and any undeclared returned field
   fails the action (existing invariant, asserted for the new adapters).
