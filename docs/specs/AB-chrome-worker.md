# AB — Operator-attached Chrome worker

Status: implementation contract
Date: 2026-08-16

## Objective

Let Toros acquire webpage metadata and declared documents through a real Chrome
tab in the operator's normal profile. The first concrete use case is a paced,
resumable run that captures product data and downloads declared documents (for
example safety data sheets and specifications) from an allowlisted site.

## Selected attachment model

The worker is an unpacked Manifest V3 Chrome extension paired to Node Core over
loopback HTTP. It uses the current operator-selected tab and requests host
permission only for origins the operator grants. A separate remote-debugging
profile is deferred; the adapter contract is transport-neutral so that it can
be added without changing acquisitions.

The extension credential is distinct from both the coordinator and operator
tokens. Pairing uses a single-use, short-lived code issued on the operator
surface. Node Core persists only the worker-token digest and the paired
extension id. The raw worker token remains in Chrome extension storage.

## Capability surface

The adapter id is `chrome` and exposes exactly:

- `chrome.navigate`: navigate the paired tab to one allowlisted HTTP(S) URL and
  return bounded page metadata;
- `chrome.extract`: return declared fields and document links from the paired
  tab, with bounded selectors, match terms, and output;
- `chrome.download`: fetch one declared URL with the paired Chrome session and
  stream it in bounded chunks to a policy-contained Toros workspace path.

There is no arbitrary JavaScript, arbitrary click, cookie/storage inspection,
password access, unrestricted browser debugger, or generic filesystem action.

## Acquisition state machine

Operator-created acquisitions run sequentially through `navigate → extract →
download declared documents → checkpoint manifest`. Each item and document has
durable status, attempts, timestamps, output path, byte count, and SHA-256.

States are `running`, `waiting`, `paused`, `completed`, and `stopped`. Running
work becomes paused after Node Core restart. The operator may pause, resume, or
stop a run. A manifest is atomically rewritten inside the selected workspace
after each state change.

Pacing uses an operator-visible minimum/maximum delay. HTTP 429 honors
`Retry-After` when present and otherwise uses capped exponential backoff with
jitter. HTTP 403, missing host permission, login/consent pages, bot challenges,
worker disconnect, exhausted attempts, or invalid downloads pause for operator
attention. Toros does not attempt to bypass access controls.

## Limits

- Node-configured domain allowlist, additionally constrained by each run's URLs.
- At most 100 items, 20 extraction fields, and 6 document rules per run.
- One paired tab and one in-flight browser command.
- 256 KiB upload chunks and 100 MiB maximum per downloaded document.
- Page text excerpts and action outputs are bounded and never include cookies,
  local storage, passwords, or complete private browser history.

## Site profiles

`site_profile` is `generic`, and Node Core rejects any other value. A site
profile would be a bounded specialization of `chrome.extract` for one site, not
a general interaction primitive: it could narrow the accepted source URLs and
resolve that site's document links, but never accept a caller-supplied click
selector, arbitrary text to click, or arbitrary JavaScript. A vendor-specific
pilot profile existed during Phase 1 and was removed before the repository was
published.

## Document outcomes and pacing

A downloaded PDF is finalized only after a 2xx response, matching MIME type,
non-zero content, and a leading `%PDF-` signature. Node Core records exact
document HTTP status/content type, bytes, SHA-256, duplicate hash reference, and
a terminal outcome. Missing links are terminal `not_found` outcomes rather than successful
zero-document captures.

The controller records `Retry-After` when present and pauses after an
operator-configured threshold of one to five consecutive HTTP 429 responses.
Cockpit defaults a run to 45–90 second pacing, two item attempts, a
three-hour maximum backoff, and a two-429 circuit breaker.

## Acceptance

1. The extension pairs with a single-use code and reconnects after restart.
2. An unpaired extension, wrong extension id, wrong token, wrong domain, unknown
   action, out-of-order chunk, or workspace escape is denied deterministically.
3. Navigate/extract/download actions pass through the ordinary job envelope,
   policy, action budget, receipt, and artifact paths.
4. A simulated multi-item run survives a controller restart with completed
   items intact and running work paused.
5. Rate limiting produces waiting/backoff state; access challenges produce an
   operator-visible pause; resume continues from the current item.
6. Cockpit shows connection/pairing, run creation, progress, next retry,
   downloaded artifacts, pause reason, and pause/resume/stop controls.
7. Package, Node Core, Cockpit, and extension syntax tests pass. A real Chrome
   acceptance run is recorded separately because loading an unpacked extension
   requires an operator gesture.
