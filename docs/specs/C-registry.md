# Spec C — `@toros/registry`

**Read `00-CONTRACTS.md` first.** It is short and it is binding.

Implements **SPEC §4.3** (adapter boundaries) and the schema-validation half of **§8.1**.
Provides the `CapabilityRegistry` port from `@toros/contracts`.

## Objective

Hold the set of adapters this node actually has, resolve a capability id to the adapter and
action that serve it, and reject arguments that do not match the action's declared schema —
before any adapter is reached.

This is what makes "the pilot desktop app exposes only its registered inspect/action schemas"
(SPEC §10 acceptance) checkable rather than aspirational. An action absent from a manifest does
not exist as far as Node Core is concerned.

## Allowed paths

```
packages/registry/package.json
packages/registry/tsconfig.json
packages/registry/src/**
packages/registry/test/**
```

## Forbidden paths

```
packages/contracts/**          frozen — see 00-CONTRACTS §1
packages/*/                    any other package
apps/**
docs/**
tools/**
```

## Package setup

Name `@toros/registry`, dependencies `"@toros/contracts": "*"` **and `"ajv": "^8"`** — this is
the one package permitted a third-party runtime dependency (00-CONTRACTS §3). Project reference
to `../contracts`.

## Public API — frozen

```ts
import type { CapabilityRegistry, Workspace } from '@toros/contracts';

export interface RegistryOptions {
  /** Workspaces this node offers. Roots must already be absolute and resolved. */
  readonly workspaces: readonly Workspace[];
  /** This node's platform, checked against each manifest. Defaults to process.platform. */
  readonly platform?: NodePlatform;
}

export function createRegistry(options: RegistryOptions): CapabilityRegistry;
```

Nothing else. Implement `CapabilityRegistry` exactly as contracts declares it.

## Registration rules

`register(adapter)` validates the manifest before calling `adapter.init()`, and refuses on any
of these with the stated code:

| Condition | Code |
|---|---|
| manifest `id` does not match `^[a-z][a-z0-9_]*$` | `E_ENVELOPE_INVALID` |
| an adapter with that `id` is already registered | `E_ENVELOPE_INVALID` |
| `manifest.platforms` does not include this node's platform | `E_NOT_REGISTERED` |
| an action `id` does not match `^[a-z][a-z0-9_]*$` | `E_ENVELOPE_INVALID` |
| two actions share an `id` | `E_ENVELOPE_INVALID` |
| an action's `input_schema` is not a compilable JSON Schema | `E_SCHEMA` |
| `default_timeout_ms` is not a positive integer | `E_ENVELOPE_INVALID` |

Order matters: **validate the whole manifest before calling `init()`**. `init()` may spawn a
process or attach to an application, and doing that for an adapter you are about to reject
leaves a resource nobody owns.

If `init()` throws, the adapter is not registered and the error propagates unchanged. An
adapter refusing to initialise on this host is a normal outcome, not a registry failure.

Compile every action's `input_schema` at registration, not at first use. A schema that cannot
compile is a defect in the adapter, and finding it at startup is much better than finding it
during a job.

## Argument validation

`validateArguments(id, args)` throws `TorosError(E_SCHEMA)` when `args` fails the compiled
schema, with `detail` carrying `{ capability: id, errors }` where `errors` is Ajv's error array
reduced to `{ path, message }` pairs. Do not put the raw Ajv objects in `detail` — they carry
the offending data, which may be a secret (00-CONTRACTS §5).

Ajv configuration:

```ts
new Ajv({ strict: true, allErrors: true, allowUnionTypes: false })
```

- `strict: true` — an action schema with a typo'd keyword is a defect the author wants to hear
  about, not a constraint silently ignored.
- `allErrors: true` — the cockpit shows every problem at once.
- **Do not enable `useDefaults` or `coerceTypes`.** Both mutate the caller's arguments. The
  arguments that reach the adapter must be byte-identical to the ones the policy engine decided
  on and the receipt recorded; a coercion between those two points means the receipt describes
  something other than what ran.

An unknown capability id throws `E_NOT_REGISTERED`, not `E_CAP_NOT_ALLOWED`. The distinction:
`E_NOT_REGISTERED` means this node cannot do it at all; `E_CAP_NOT_ALLOWED` means this job may
not. Policy raises the second; the registry only ever raises the first.

## Resolution

`get(id)` splits on the single `.`, returning `null` for anything unknown or malformed rather
than throwing — callers use it to test existence. `list()` returns every registered capability
id sorted, regardless of any envelope: the registry knows nothing about jobs.

`workspaces()` returns the configured list unchanged.

## Acceptance tests

`packages/registry/test/registry.test.ts`. Write a small mock adapter as a fixture inside your
own test directory; do not import one from another package.

1. `registers a valid adapter and lists its capabilities as adapter.action`
2. `list returns capabilities sorted and is unaffected by any envelope`
3. `rejects a duplicate adapter id`
4. `rejects a manifest whose platforms exclude this node with E_NOT_REGISTERED`
5. `rejects duplicate action ids within one manifest`
6. `rejects an uncompilable input_schema with E_SCHEMA`
7. `validates the manifest before calling init` — assert `init` was never called on a rejected adapter
8. `propagates an init failure and leaves the adapter unregistered`
9. `get returns null for an unknown id rather than throwing`
10. `get returns null for a malformed id`
11. `validateArguments accepts arguments matching the schema`
12. `validateArguments throws E_SCHEMA with path and message pairs in detail`
13. `validateArguments throws E_NOT_REGISTERED for an unknown capability`
14. `validateArguments does not mutate the arguments object` — pass a schema with a `default`, assert the input is unchanged
15. `validateArguments does not coerce a string to a number`
16. `detail does not contain the offending argument values`

Tests 14, 15, and 16 are the ones that matter most here. The first two guard the receipt's
truthfulness; the third guards against leaking a secret into an error path that gets logged.

## Verification

```
npx tsc --build packages/registry
node --test packages/registry/dist/test/*.test.js
```

Clean, zero skips.

## Out of scope

Deciding whether a job may use a capability — that is `packages/policy`. Running an action,
supervising a process, persistence, and paths. The registry knows what exists; it never knows
what is permitted.
