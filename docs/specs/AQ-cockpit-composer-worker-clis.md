# AQ — Visible Work composer and Gemini-AGY/Grok workers

Status: accepted by operator request on 2026-09-04

## Objective

Keep the message composer visible when the operator opens Cockpit's **Work → Ask Hermes**
surface, and make the already verified Antigravity and Grok command-line protocols available as
first-class Toros workers.

## Acceptance

1. The Hermes panel fits the available desktop viewport; its conversation thread scrolls inside
   the panel while the composer remains visible without page scrolling.
2. Narrow layouts retain a usable bounded panel rather than restoring the old fixed thread
   minimum height.
3. Node Core can register `gemini` (Antigravity/`agy` through WSL) and `grok` adapters from the
   local configuration file.
4. Each worker exposes the standard `start`, `send`, `read`, `interrupt`, and `stop` lifecycle,
   pins its verified policy flags, resumes its native conversation identifier, and has hermetic
   framing coverage.
5. Cockpit's worker selector labels the Antigravity-backed adapter **Gemini (AGY)** and lists Grok
   when their capabilities are registered.
6. Deployment documentation gives configuration examples without embedding credentials or a
   machine-specific model choice.

## In scope

- `apps/cockpit/src/components/HermesChat*`
- `apps/cockpit/src/styles.css`
- `packages/adapters-cli/src/**` and `packages/adapters-cli/test/**`
- `packages/node-core/src/main.ts`
- `docs/DEPLOY.md`, the two CLI finding documents, and this spec

## Out of scope

- Merging, deployment, scheduled-task changes, or editing the operator's live configuration.
- Closing or rewriting PR #15.
- OpenCode or any additional worker protocol.
- A new remote shell, a wider capability surface, or weaker sandbox/approval policy.
