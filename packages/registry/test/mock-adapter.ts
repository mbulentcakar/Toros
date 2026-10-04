import type {
  ActionResult,
  Adapter,
  AdapterContext,
  AdapterManifest,
  JsonValue,
  NodePlatform,
} from '@toros/contracts';

export interface MockAdapterOptions {
  readonly id?: string;
  readonly version?: string;
  readonly platforms?: readonly NodePlatform[];
  readonly actions?: AdapterManifest['actions'];
  readonly required_permissions?: AdapterManifest['required_permissions'];
  readonly allowed_resources?: readonly string[];
  readonly default_timeout_ms?: number;
  readonly cancellation?: AdapterManifest['cancellation'];
  readonly receipt_fields?: readonly string[];
  /** If set, init() rejects with this error. */
  readonly initError?: Error;
  /** Called when init() runs (only if initError is not set). */
  readonly onInit?: () => void;
}

/**
 * Minimal in-test adapter. Lives in this package only — do not import adapters
 * from other packages.
 */
export function createMockAdapter(options: MockAdapterOptions = {}): Adapter & {
  readonly initCalled: boolean;
} {
  let initCalled = false;

  const manifest: AdapterManifest = {
    id: options.id ?? 'mock',
    version: options.version ?? '1.0.0',
    platforms: options.platforms ?? ['win32', 'darwin', 'linux'],
    actions: options.actions ?? [
      {
        id: 'echo',
        summary: 'Echo arguments',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        path_fields: [], mutates: false,
        always_requires_approval: false,
      },
    ],
    required_permissions: options.required_permissions ?? [],
    allowed_resources: options.allowed_resources ?? [],
    default_timeout_ms: options.default_timeout_ms ?? 5_000,
    cancellation: options.cancellation ?? 'graceful',
    receipt_fields: options.receipt_fields ?? [],
  };

  const adapter: Adapter = {
    get manifest() {
      return manifest;
    },
    async init(): Promise<void> {
      initCalled = true;
      if (options.initError) {
        throw options.initError;
      }
      options.onInit?.();
    },
    async invoke(
      _actionId: string,
      _args: Readonly<Record<string, JsonValue>>,
      _ctx: AdapterContext,
    ): Promise<ActionResult> {
      return {
        output: '',
        truncated: false,
        artifacts: [],
        receipt_extra: {},
      };
    },
    async dispose(): Promise<void> {
      // no-op
    },
  };

  return Object.defineProperty(adapter, 'initCalled', {
    get: () => initCalled,
    enumerable: true,
  }) as Adapter & { readonly initCalled: boolean };
}
