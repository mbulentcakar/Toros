# AG — Pattern-based secret redaction

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

`redactSecrets` in Node Core strips exactly the credentials Toros minted: the
node bearer, the operator token, and live run tokens. An operator who pastes an
OpenRouter, Anthropic, GitHub, or cloud key into the Hermes chat box puts it
verbatim into durable history — and from there into every future rehydrated
model context. The UI warns; the system does not enforce. The claim "a live
credential cannot enter durable history" currently holds only for credentials
Toros issued itself.

The relay already does pattern-based secret scanning before capsule creation.
This spec consolidates that knowledge into one shared module and applies it at
the store choke point where known-token redaction already runs.

## The change

**One module, `@toros/contracts` (or a sibling pure package), exporting:**

```ts
redactPatterns(text: string): { text: string; hits: readonly string[] }
```

where `hits` names the pattern kinds found (`openai_key`, `aws_access_key`,
…), never the matched values. Pure function, zero dependencies, exhaustive
test vectors.

**The initial pattern set** — each anchored to a documented prefix or
structure, chosen for near-zero false-positive rates:

- `sk-` / `sk-ant-` / `sk-proj-` keys (OpenAI/Anthropic shape)
- `AKIA[0-9A-Z]{16}` (AWS access key id)
- `ghp_`, `gho_`, `github_pat_` (GitHub)
- `xox[bpars]-` (Slack)
- `AIza[0-9A-Za-z_-]{35}` (Google API)
- `eyJ` … `.` … `.` … three-part JWT shape with base64url segments ≥ 20 chars
- `-----BEGIN … PRIVATE KEY-----` PEM blocks (the whole block)
- `Bearer <token ≥ 20 chars>` inside pasted HTTP header lines

Replacement is `[redacted:<kind>]`. **No entropy heuristics** — a
high-entropy detector redacts product ids and hashes, and a redactor that
mangles ordinary text will get turned off. Anchored patterns only; the list is
versioned in the module and extended by adding a pattern with its test vector.

**Call sites.** Node Core's `redactSecrets` becomes known-token redaction
*plus* `redactPatterns`, which means the same coverage automatically applies
everywhere it is already called: operator turns, coordinator turns, envelope
free-text at sealing. The relay's scanner adopts the shared module for its
detection list, keeping its own block-on-detect behavior (a capsule with a
finding is refused; a chat turn is redacted and stored — different surfaces,
different correct responses, one pattern list).

When redaction fires on an operator turn, append an event
(`redaction.applied`, payload: kinds, turn reference) so the audit trail
records that stored text differs from what was typed.

## Non-goals

- No redaction of receipts' `arguments_digest` path — arguments are already
  digest-only in receipts.
- No un-redaction, no vault, no secret detection in worker file output
  (that is Numbat's territory, SPEC §8.2).

## Acceptance

1. Each pattern has a positive vector (redacted, correct kind) and a negative
   vector (similar-but-legitimate text untouched). UUIDs, git SHAs, and
   ordinary base64 survive unredacted.
2. Pasting a synthetic `sk-ant-…` key into the Hermes chat stores
   `[redacted:anthropic_key]`, the model context on the next run contains the
   redacted form, and a `redaction.applied` event exists.
3. An objective containing a synthetic key seals with the redacted text and
   the digest is computed over the redacted form.
4. The relay refuses a capsule containing a file with a synthetic PEM block,
   citing the shared module's kind name.
5. Known-token redaction (bearer, operator, run tokens) is unchanged and
   still covered by its existing tests.
