# The cockpit cannot reach Node Core

**Found:** 2026-08-06, by opening the installed cockpit and looking at it.
**Symptom:** `Could not reach Node Core — 0 Unavailable: Failed to fetch`
**Status:** open. Phase 1 acceptance items that depend on the cockpit displaying
anything cannot pass until it is fixed.

## What happens

The cockpit's WebView runs on a Tauri origin (`http://tauri.localhost` on
Windows). Every call it makes to `http://127.0.0.1:<port>` is therefore
**cross-origin**, and two independent things stop it:

1. **Node Core refuses any request carrying an `Origin` header.**

   ```
   without Origin:  400   (reached the handler)
   with    Origin:  403   {"error":"Origin is not allowed"}
   ```

   A browser sets `Origin` on cross-origin requests; the page cannot opt out.

2. **Node Core sends no CORS headers.** Even if the 403 were removed, the
   browser would discard the response for lacking
   `Access-Control-Allow-Origin`, which is what produces `status 0` and
   `Failed to fetch` rather than a readable HTTP error.

## Why the tests did not catch it

The cockpit's own test 9 asserts that *our code* does not add an `Origin`
header. That is true and irrelevant: the user agent adds it. The test's comment
has said so since it was written —

> It does NOT prove that none is sent over the wire: in a real Tauri WebView the
> user agent controls that header.

— and a jsdom test structurally cannot check the other half.

The CSP test added later asserts `connect-src` is confined to loopback. Also
true, also silent on whether the request survives.

And the live check run during the install used PowerShell, which sends no
`Origin`. **That verified a client nobody uses.**

## Two ways out

**A. Allow a specific origin and emit CORS headers.** Cheap, and wrong in the
direction that matters: it deletes a tested control (SPEC §8 treats
loopback-plus-no-Origin as a defence, and there is an acceptance test asserting
the 403), it needs CORS preflight — `OPTIONS` — which contradicts the
POST-only surface, and it leaves the bearer token inside the WebView.

**B. Proxy through Rust.** The WebView calls a Tauri command; the Rust side
makes the HTTP request to Node Core and returns the result. Preferred:

- No browser origin is involved, so Node Core's "no Origin" rule stays exactly
  as specified and stays tested.
- No CORS, no preflight, no change to the POST-only surface.
- **The token never enters the WebView at all.** Today
  `read_node_core_config` hands both bearers to JavaScript; with a proxy it
  hands over neither, which is strictly better than what the cockpit has now
  and closer to what SPEC §4.1 means by the cockpit holding no authority.

The cost is that every call in `apps/cockpit/src/api.ts` moves from `fetch` to
`invoke`, and the 26 cockpit tests mock `invoke` instead of `fetch`.

**Recommendation: B.** A is a smaller diff that trades away a control and keeps
credentials in the least trustworthy place.

## The wider lesson

Three separate tests said the transport was fine. None of them exercised the
transport. This was found in the first thirty seconds of a human looking at the
running application — which is the argument for doing that earlier, not the
argument for more tests of the same kind.
