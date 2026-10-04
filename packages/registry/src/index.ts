import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';

import {
  ErrorCode,
  TorosError,
  type Adapter,
  type CapabilityId,
  type CapabilityRegistry,
  type JsonValue,
  type NodePlatform,
  type Workspace,
} from '@toros/contracts';

/** Identifiers that appear as adapter or action ids (half of a CapabilityId). */
const SEGMENT_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface RegistryOptions {
  /** Workspaces this node offers. Roots must already be absolute and resolved. */
  readonly workspaces: readonly Workspace[];
  /** This node's platform, checked against each manifest. Defaults to process.platform. */
  readonly platform?: NodePlatform;
}

interface CompiledAction {
  readonly actionId: string;
  readonly validate: ValidateFunction;
}

interface RegisteredAdapter {
  readonly adapter: Adapter;
  /** actionId → compiled schema validator */
  readonly actions: ReadonlyMap<string, CompiledAction>;
}

/**
 * Ajv is configured without useDefaults or coerceTypes so the arguments that
 * reach the adapter stay byte-identical to those policy decided on and the
 * receipt recorded (SPEC C, 00-CONTRACTS §5).
 *
 * Import Ajv2020 from the ESM entry — under NodeNext, `import Ajv from 'ajv'`
 * yields the CommonJS namespace, not the constructor (00-CONTRACTS §3).
 */
function createAjv(): Ajv2020 {
  return new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: false,
  });
}

/** Reduce Ajv errors to path/message pairs — never the raw objects (secrets). */
function reduceAjvErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly { readonly path: string; readonly message: string }[] {
  if (!errors || errors.length === 0) {
    return [{ path: '', message: 'schema validation failed' }];
  }
  return errors.map((e) => ({
    path: e.instancePath === '' ? '/' : e.instancePath,
    message: e.message ?? 'validation failed',
  }));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function resolvePlatform(platform: NodePlatform | undefined): NodePlatform {
  if (platform !== undefined) {
    return platform;
  }
  const p = process.platform;
  if (p === 'win32' || p === 'darwin' || p === 'linux') {
    return p;
  }
  // Unsupported host OS: no NodePlatform value fits. Callers that care should
  // pass platform explicitly; otherwise every adapter is refused as unsupported.
  throw new TorosError(
    ErrorCode.E_NOT_REGISTERED,
    `unsupported process.platform "${p}" — pass RegistryOptions.platform explicitly`,
    { platform: p },
  );
}

class Registry implements CapabilityRegistry {
  private readonly workspacesList: readonly Workspace[];
  private readonly platform: NodePlatform;
  private readonly ajv: Ajv2020;
  /** adapter id → registration */
  private readonly adapters = new Map<string, RegisteredAdapter>();
  /** fully-qualified capability id → { adapter, actionId, validate } */
  private readonly capabilities = new Map<
    string,
    { readonly adapter: Adapter; readonly actionId: string; readonly validate: ValidateFunction }
  >();

  constructor(options: RegistryOptions) {
    this.workspacesList = options.workspaces;
    this.platform = resolvePlatform(options.platform);
    this.ajv = createAjv();
  }

  async register(adapter: Adapter): Promise<void> {
    const { manifest } = adapter;

    // Validate the whole manifest before init() — init may spawn processes.
    this.validateManifest(manifest);

    // Compile every input_schema now so uncompilable schemas fail at startup.
    const compiledActions = new Map<string, CompiledAction>();
    for (const action of manifest.actions) {
      let validate: ValidateFunction;
      try {
        // input_schema is JsonValue by contract, because a JSON Schema is just
        // a JSON document. Ajv's compile() is narrower — it takes an object or
        // a boolean schema — so reject the other JsonValue shapes here rather
        // than casting past the signature. A string or number where a schema
        // belongs is a defect in the adapter's manifest, and E_SCHEMA at
        // registration is exactly where the author wants to hear about it.
        if (
          action.input_schema === null ||
          (typeof action.input_schema !== 'object' && typeof action.input_schema !== 'boolean')
        ) {
          throw new TypeError('input_schema must be a JSON Schema object or boolean');
        }
        validate = this.ajv.compile(action.input_schema as AnySchema);
      } catch (cause: unknown) {
        const message =
          cause instanceof Error ? cause.message : 'input_schema is not a compilable JSON Schema';
        throw new TorosError(
          ErrorCode.E_SCHEMA,
          `action "${action.id}" has an uncompilable input_schema: ${message}`,
          {
            adapter: manifest.id,
            action: action.id,
          },
        );
      }
      compiledActions.set(action.id, { actionId: action.id, validate });
    }

    await adapter.init();

    // Only after successful init() do we commit the registration.
    this.adapters.set(manifest.id, { adapter, actions: compiledActions });
    for (const [actionId, compiled] of compiledActions) {
      const capId = `${manifest.id}.${actionId}`;
      this.capabilities.set(capId, {
        adapter,
        actionId,
        validate: compiled.validate,
      });
    }
  }

  /**
   * Pure validation of a manifest. Throws TorosError on any defect.
   * Does not call init() and does not mutate registry state.
   */
  private validateManifest(manifest: Adapter['manifest']): void {
    if (!SEGMENT_PATTERN.test(manifest.id)) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `adapter id "${manifest.id}" does not match ^[a-z][a-z0-9_]*$`,
        { adapter: manifest.id },
      );
    }

    if (this.adapters.has(manifest.id)) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `adapter id "${manifest.id}" is already registered`,
        { adapter: manifest.id },
      );
    }

    if (!manifest.platforms.includes(this.platform)) {
      throw new TorosError(
        ErrorCode.E_NOT_REGISTERED,
        `adapter "${manifest.id}" does not support platform "${this.platform}"`,
        { adapter: manifest.id, platform: this.platform, platforms: [...manifest.platforms] },
      );
    }

    if (!isPositiveInteger(manifest.default_timeout_ms)) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `adapter "${manifest.id}" default_timeout_ms must be a positive integer`,
        { adapter: manifest.id, default_timeout_ms: manifest.default_timeout_ms },
      );
    }

    const seenActionIds = new Set<string>();
    for (const action of manifest.actions) {
      if (!SEGMENT_PATTERN.test(action.id)) {
        throw new TorosError(
          ErrorCode.E_ENVELOPE_INVALID,
          `action id "${action.id}" does not match ^[a-z][a-z0-9_]*$`,
          { adapter: manifest.id, action: action.id },
        );
      }
      if (seenActionIds.has(action.id)) {
        throw new TorosError(
          ErrorCode.E_ENVELOPE_INVALID,
          `adapter "${manifest.id}" has duplicate action id "${action.id}"`,
          { adapter: manifest.id, action: action.id },
        );
      }
      seenActionIds.add(action.id);
    }
  }

  list(): readonly CapabilityId[] {
    return [...this.capabilities.keys()].sort();
  }

  get(id: CapabilityId): { readonly adapter: Adapter; readonly actionId: string } | null {
    // Split on the single '.' — anything malformed or unknown returns null.
    const dot = id.indexOf('.');
    if (dot <= 0 || id.indexOf('.', dot + 1) !== -1 || dot === id.length - 1) {
      return null;
    }
    const entry = this.capabilities.get(id);
    if (!entry) {
      return null;
    }
    return { adapter: entry.adapter, actionId: entry.actionId };
  }

  validateArguments(id: CapabilityId, args: Readonly<Record<string, JsonValue>>): void {
    const entry = this.capabilities.get(id);
    if (!entry) {
      // Unknown capability is E_NOT_REGISTERED — the registry never knows permission.
      throw new TorosError(ErrorCode.E_NOT_REGISTERED, `capability "${id}" is not registered`, {
        capability: id,
      });
    }

    const ok = entry.validate(args);
    if (!ok) {
      const errors = reduceAjvErrors(entry.validate.errors);
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `arguments for capability "${id}" failed schema validation`,
        {
          capability: id,
          errors,
        },
      );
    }
  }

  workspaces(): readonly Workspace[] {
    return this.workspacesList;
  }
}

export function createRegistry(options: RegistryOptions): CapabilityRegistry {
  return new Registry(options);
}
