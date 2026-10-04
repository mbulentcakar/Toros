# AM — DeepL adapter, and what a network API adapter must declare

Status: proposed — drafted by Claude, not yet operator-accepted
Date: 2026-08-19

## Objective

The first adapter whose action is a network call rather than a process or a
COM object. DeepL is the concrete case (SDS/report translation is planned
work in the surrounding projects), but the precedent is the point: this spec
defines what any future API adapter must declare, so the second one is a
pattern instance and not a new negotiation.

## The API-adapter rules (normative for this and every successor)

1. **Egress is declared in the manifest.** A new manifest field,
   `network_endpoints`, lists exact origins (`https://api.deepl.com`). The
   registry rejects an API adapter without it; the adapter constructs URLs
   only from that list. This puts network reach where capability reach
   already lives — in a declared, reviewable manifest, not in code someone
   has to audit.
2. **The credential never enters the action path.** API keys live in
   operator config, are handed to the adapter at construction, and appear in
   no action argument, receipt field, model context, or error message. The
   key's *config name* may appear in receipts; its value may not. AG's
   pattern redaction is a backstop, not the mechanism.
3. **Bounded requests, honest failures.** Input size caps in the schema;
   HTTP 429/456 map to a distinct retryable error carrying `Retry-After`
   when present; quota exhaustion is a failure the receipt records, never a
   silent partial result.
4. **No response passthrough.** The adapter parses the response and returns
   the declared output shape; unexpected response structure is
   `E_ADAPTER_FAILURE`, not forwarded JSON.

## DeepL (`deepl`)

One action to start:

- `deepl.translate_text` — `{ text, target_lang, source_lang? }`;
  `text` ≤ 100 KiB; language codes from DeepL's published set, validated in
  the schema. Output: translated text plus `detected_source_lang`.

`receipt_fields`: `characters_billed`, `detected_source_lang`. These are the
audit-relevant facts — billing exposure and what the service inferred.

Document translation (`translate_document`) is explicitly deferred: it is a
multi-request stateful flow (upload/poll/download) and deserves its own
acceptance criteria once text translation has receipts behind it.

Free-tier vs paid endpoint (`api-free.deepl.com` vs `api.deepl.com`) is an
operator config choice; both origins may appear in `network_endpoints`, and
the configured one is used.

## Non-goals

- No translation memory, no glossaries, no batching, no caching of
  translations (a cache is a second store of tenant-adjacent content with
  its own retention questions — out of scope until someone needs it enough
  to spec it).
- No generalized HTTP action. `network_endpoints` is not a step toward a
  `fetch` capability; a generic fetch is exactly the unrestricted surface
  SPEC §2 exists to refuse.

## Acceptance

1. Registry rejects an API adapter whose manifest lacks `network_endpoints`;
   a URL outside the declared origin cannot be constructed (unit test at the
   adapter, not just review).
2. `translate_text` round-trips a fixture against the real API on the
   operator machine (self-skipping in CI per AJ), receipt carrying
   `characters_billed`.
3. A synthetic 429 with `Retry-After` surfaces as the retryable error with
   the delay attached; a 456 surfaces as quota exhaustion; both receipts
   record the outcome.
4. The API key appears in no receipt, event, turn, artifact, or error
   message produced by a full test run — asserted by grepping the test
   database and captured output for the fixture key.
5. Oversized `text` and an invalid `target_lang` fail schema validation
   before any network call (the adapter records zero requests).
