import { createHash, randomBytes, randomUUID, timingSafeEqual, type Hash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  ErrorCode,
  TorosError,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type JsonValue,
} from '@toros/contracts';

const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const CONNECTED_WINDOW_MS = 45_000;
const PAIRING_TTL_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;

export interface ChromeWorkerOptions {
  readonly allowed_domains: readonly string[];
  readonly state_path: string;
  readonly extension_dir?: string;
  readonly command_timeout_ms?: number;
  readonly now?: () => Date;
}

export interface ChromeWorkerTab {
  readonly id: number;
  readonly url: string;
  readonly title: string;
}

export interface ChromeWorkerStatus {
  readonly paired: boolean;
  readonly connected: boolean;
  readonly extension_id: string | null;
  readonly extension_version: string | null;
  readonly paired_at: string | null;
  readonly last_seen_at: string | null;
  readonly tab: ChromeWorkerTab | null;
  readonly allowed_domains: readonly string[];
  readonly extension_dir: string | null;
  readonly queued_commands: number;
  readonly active_command: string | null;
}

export interface ChromePairingCode {
  readonly code: string;
  readonly expires_at: string;
}

export interface ChromeWorkerCommand {
  readonly command_id: string;
  readonly action: 'navigate' | 'extract' | 'download';
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly deadline_at: string;
}

export interface ChromeWorkerPollInput {
  readonly extension_version: string;
  readonly tab: ChromeWorkerTab | null;
}

export interface ChromeWorkerResultInput {
  readonly command_id: string;
  readonly ok: boolean;
  readonly output?: JsonValue;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retry_after_seconds?: number;
    readonly http_status?: number;
    readonly content_type?: string;
  };
}

export interface ChromeUploadChunkInput {
  readonly upload_id: string;
  readonly index: number;
  readonly data: string;
  readonly final: boolean;
  readonly mime_type?: string;
  readonly http_status?: number;
}

interface PersistedWorkerState {
  readonly version: 1;
  readonly token_digest: string;
  readonly extension_id: string;
  readonly paired_at: string;
}

interface PairingState {
  readonly code: string;
  readonly expiresAt: number;
  attempts: number;
}

interface PendingCommand {
  readonly command: ChromeWorkerCommand;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly uploadId: string | null;
  delivered: boolean;
}

interface UploadState {
  readonly uploadId: string;
  readonly commandId: string;
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly maxBytes: number;
  readonly expectedMime: string | null;
  readonly hash: Hash;
  header: Buffer;
  nextIndex: number;
  bytes: number;
  completed: boolean;
  sha256: string | null;
  mimeType: string | null;
  httpStatus: number | null;
}

function fail(message: string, detail: Record<string, JsonValue> = {}): never {
  throw new TorosError(ErrorCode.E_ADAPTER_FAILURE, message, detail);
}

function schema(message: string): never {
  throw new TorosError(ErrorCode.E_SCHEMA, message, {});
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!DOMAIN_PATTERN.test(domain)) throw new TypeError(`invalid Chrome worker domain: ${input}`);
  return domain;
}

function allowedUrl(raw: string, domains: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { schema('Chrome worker URL must be absolute'); }
  if (url.protocol !== 'https:') schema('Chrome worker permits HTTPS URLs only');
  const host = url.hostname.toLowerCase();
  if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new TorosError(ErrorCode.E_FORBIDDEN, `Chrome worker domain is not allowlisted: ${host}`, { host });
  }
  url.username = '';
  url.password = '';
  return url;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max) schema(`${name} is invalid`);
  return value;
}

function positiveInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) schema(`${name} must be an integer from 1 to ${max}`);
  return value;
}

function asObject(value: unknown): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) schema('Chrome worker output must be an object');
  return value as Record<string, JsonValue>;
}

function safeJson(value: JsonValue): string {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) fail('Chrome worker output exceeded its limit', { limit: MAX_OUTPUT_BYTES });
  return output;
}

function equalDigest(token: string, digest: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const expected = Buffer.from(digest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isChromeExtensionOrigin(origin: string | undefined): origin is string {
  return typeof origin === 'string' && EXTENSION_ORIGIN_PATTERN.test(origin);
}

export interface ChromeWorkerAdapter extends Adapter {
  readonly worker_kind: 'toros.chrome';
  createPairingCode(): ChromePairingCode;
  pair(code: string, origin: string): Promise<{ readonly token: string; readonly status: ChromeWorkerStatus }>;
  authenticate(token: string, origin: string): boolean;
  status(): ChromeWorkerStatus;
  poll(input: ChromeWorkerPollInput): { readonly command: ChromeWorkerCommand | null };
  submitResult(input: ChromeWorkerResultInput): Promise<void>;
  uploadChunk(input: ChromeUploadChunkInput): Promise<{ readonly accepted: true; readonly bytes: number }>;
}

export function isChromeWorkerAdapter(adapter: Adapter): adapter is ChromeWorkerAdapter {
  return 'worker_kind' in adapter && adapter.worker_kind === 'toros.chrome';
}

export function createChromeWorkerAdapter(options: ChromeWorkerOptions): ChromeWorkerAdapter {
  const domains = [...new Set(options.allowed_domains.map(normalizeDomain))];
  if (domains.length === 0) throw new TypeError('Chrome worker requires at least one allowed domain');
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.command_timeout_ms ?? COMMAND_TIMEOUT_MS;
  let persisted: PersistedWorkerState | null = null;
  let pairing: PairingState | null = null;
  let extensionVersion: string | null = null;
  let lastSeenAt: string | null = null;
  let tab: ChromeWorkerTab | null = null;
  const queue: PendingCommand[] = [];
  const pending = new Map<string, PendingCommand>();
  const uploads = new Map<string, UploadState>();
  let active: PendingCommand | null = null;

  async function persistState(): Promise<void> {
    if (persisted === null) return;
    await mkdir(dirname(options.state_path), { recursive: true });
    const temporary = `${options.state_path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(persisted, null, 2), 'utf8');
    await rename(temporary, options.state_path);
  }

  async function cleanupUpload(uploadId: string | null): Promise<void> {
    if (uploadId === null) return;
    const upload = uploads.get(uploadId);
    uploads.delete(uploadId);
    if (upload !== undefined && !upload.completed) await rm(upload.temporaryPath, { force: true }).catch(() => undefined);
  }

  function finishPending(commandId: string): PendingCommand {
    const command = pending.get(commandId);
    if (command === undefined) fail('Unknown or expired Chrome worker command', { command_id: commandId });
    pending.delete(commandId);
    const queueIndex = queue.indexOf(command);
    if (queueIndex >= 0) queue.splice(queueIndex, 1);
    if (active === command) active = null;
    clearTimeout(command.timer);
    return command;
  }

  function connected(): boolean {
    return persisted !== null && lastSeenAt !== null && now().getTime() - Date.parse(lastSeenAt) <= CONNECTED_WINDOW_MS;
  }

  function workerError(input: ChromeWorkerResultInput['error']): TorosError {
    const code = input?.code?.slice(0, 64) || 'worker_failed';
    const message = input?.message?.slice(0, 500) || 'Chrome worker action failed';
    return new TorosError(ErrorCode.E_ADAPTER_FAILURE, message, {
      worker_code: code,
      ...(typeof input?.retry_after_seconds === 'number' ? { retry_after_seconds: input.retry_after_seconds } : {}),
      ...(typeof input?.http_status === 'number' ? { http_status: input.http_status } : {}),
      ...(typeof input?.content_type === 'string' ? { content_type: input.content_type.slice(0, 128) } : {}),
    });
  }

  async function execute(
    action: ChromeWorkerCommand['action'],
    payload: Record<string, JsonValue>,
    ctx: AdapterContext,
    uploadId: string | null,
  ): Promise<JsonValue> {
    if (!connected() || tab === null) fail('Chrome worker is not connected to a paired tab', { worker_code: 'not_connected' });
    if (active !== null || queue.length > 0) fail('Chrome worker already has an active command', { worker_code: 'busy' });
    const commandId = randomUUID();
    const command: ChromeWorkerCommand = {
      command_id: commandId,
      action,
      payload,
      deadline_at: new Date(now().getTime() + timeoutMs).toISOString(),
    };
    return new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const entry = pending.get(commandId);
        if (entry === undefined) return;
        pending.delete(commandId);
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        if (active === entry) active = null;
        void cleanupUpload(uploadId);
        rejectPromise(new TorosError(ErrorCode.E_TIMEOUT, 'Chrome worker command timed out', { command_id: commandId }));
      }, timeoutMs);
      timer.unref();
      const entry: PendingCommand = { command, resolve: resolvePromise, reject: rejectPromise, timer, uploadId, delivered: false };
      pending.set(commandId, entry);
      queue.push(entry);
      const abort = (): void => {
        if (!pending.has(commandId)) return;
        finishPending(commandId);
        void cleanupUpload(uploadId);
        rejectPromise(new TorosError(ErrorCode.E_CANCELLED, 'Chrome worker command was cancelled', { command_id: commandId }));
      };
      if (ctx.signal.aborted) abort();
      else ctx.signal.addEventListener('abort', abort, { once: true });
    });
  }

  const adapter: ChromeWorkerAdapter = {
    worker_kind: 'toros.chrome',
    manifest: {
      id: 'chrome', version: '0.1.0', platforms: ['win32', 'darwin', 'linux'],
      required_permissions: ['app.automation', 'network.loopback', 'fs.write'],
      allowed_resources: ['browser-acquisitions/**'],
      default_timeout_ms: 90_000,
      cancellation: 'graceful',
      receipt_fields: ['chrome_tab_id', 'page_url', 'http_status', 'worker_command_id', 'mime_type'],
      actions: [
        {
          id: 'navigate', summary: 'Navigate the paired Chrome tab to one allowlisted HTTPS URL.',
          input_schema: {
            type: 'object', additionalProperties: false, required: ['url'],
            properties: { url: { type: 'string', minLength: 1, maxLength: 4096 }, wait_ms: { type: 'integer', minimum: 0, maximum: 15000 } },
          },
          path_fields: [], mutates: true, always_requires_approval: false, timeout_ms: 90_000, output_limit_bytes: MAX_OUTPUT_BYTES,
        },
        {
          id: 'extract', summary: 'Extract declared fields and matching document links from the paired tab.',
          input_schema: {
            type: 'object', additionalProperties: false, required: ['fields', 'documents'],
            properties: {
              fields: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['name', 'selector'], properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, selector: { type: 'string', minLength: 1, maxLength: 256 }, attribute: { type: 'string', minLength: 1, maxLength: 64 } } } },
              documents: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['kind', 'text_contains', 'url_contains'], properties: { kind: { type: 'string', minLength: 1, maxLength: 64 }, text_contains: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 80 } }, url_contains: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 } }, required: { type: 'boolean' } } } },
              site_profile: { type: 'string', enum: ['generic'] },
            },
          },
          path_fields: [], mutates: false, always_requires_approval: false, output_limit_bytes: MAX_OUTPUT_BYTES,
        },
        {
          id: 'download', summary: 'Stream one allowlisted document through Chrome into a contained workspace path.',
          input_schema: {
            type: 'object', additionalProperties: false, required: ['url', 'out_path', 'max_bytes', 'expected_mime'],
            properties: { url: { type: 'string', minLength: 1, maxLength: 4096 }, out_path: { type: 'string', minLength: 1, maxLength: 4096 }, max_bytes: { type: 'integer', minimum: 1, maximum: MAX_DOCUMENT_BYTES }, expected_mime: { type: 'string', minLength: 1, maxLength: 128 } },
          },
          path_fields: ['out_path'], mutates: true, always_requires_approval: false, timeout_ms: COMMAND_TIMEOUT_MS, output_limit_bytes: 64 * 1024,
        },
      ],
    },

    async init(): Promise<void> {
      try {
        const value = JSON.parse(await readFile(options.state_path, 'utf8')) as PersistedWorkerState;
        if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.token_digest) || !/^[a-p]{32}$/.test(value.extension_id)) {
          throw new Error('invalid Chrome worker state');
        }
        persisted = value;
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    },

    async invoke(actionId: string, args: Readonly<Record<string, JsonValue>>, ctx: AdapterContext): Promise<ActionResult> {
      if (actionId !== 'navigate' && actionId !== 'extract' && actionId !== 'download') {
        throw new TorosError(ErrorCode.E_NOT_REGISTERED, `chrome has no action "${actionId}"`, { action_id: actionId });
      }
      let output: JsonValue;
      let artifact: ActionResult['artifacts'][number] | null = null;
      let uploadId: string | null = null;
      if (actionId === 'navigate') {
        const url = allowedUrl(boundedString(args['url'], 'url', 4096), domains);
        output = await execute('navigate', { url: url.toString(), wait_ms: typeof args['wait_ms'] === 'number' ? args['wait_ms'] : 1500 }, ctx, null);
      } else if (actionId === 'extract') {
        const profile = args['site_profile'] ?? 'generic';
        if (profile !== 'generic') schema('site_profile is invalid');
        output = await execute('extract', { fields: args['fields'] ?? [], documents: args['documents'] ?? [], site_profile: profile }, ctx, null);
      } else {
        const url = allowedUrl(boundedString(args['url'], 'url', 4096), domains);
        const outPath = resolve(boundedString(args['out_path'], 'out_path', 4096));
        if (!isInside(ctx.workspace.root, outPath)) throw new TorosError(ErrorCode.E_PATH_ESCAPE, 'Chrome download path escaped its workspace', { out_path: outPath });
        const maxBytes = positiveInteger(args['max_bytes'], 'max_bytes', MAX_DOCUMENT_BYTES);
        const expectedMime = boundedString(args['expected_mime'], 'expected_mime', 128).toLowerCase();
        await mkdir(dirname(outPath), { recursive: true });
        uploadId = randomUUID();
        const temporaryPath = `${outPath}.${uploadId}.part`;
        uploads.set(uploadId, {
          uploadId, commandId: '', targetPath: outPath, temporaryPath, maxBytes, expectedMime,
          hash: createHash('sha256'), header: Buffer.alloc(0), nextIndex: 0, bytes: 0, completed: false, sha256: null, mimeType: null, httpStatus: null,
        });
        try {
          output = await execute('download', { url: url.toString(), upload_id: uploadId, max_bytes: maxBytes, expected_mime: expectedMime, chunk_bytes: MAX_CHUNK_BYTES }, ctx, uploadId);
          const upload = uploads.get(uploadId);
          if (upload === undefined || !upload.completed || upload.sha256 === null) fail('Chrome worker did not finalize its download', { worker_code: 'incomplete_upload' });
          const reported = asObject(output);
          if (typeof reported['url'] === 'string') allowedUrl(reported['url'], domains);
          safeJson(output);
          const info = await stat(outPath);
          artifact = { path: outPath, sha256: upload.sha256, bytes: info.size };
          uploads.delete(uploadId);
        } catch (error: unknown) {
          const upload = uploads.get(uploadId);
          if (upload?.completed) await rm(upload.targetPath, { force: true }).catch(() => undefined);
          await cleanupUpload(uploadId);
          throw error;
        }
      }
      const object = asObject(output);
      const pageUrl = typeof object['url'] === 'string' ? object['url'] : typeof object['page_url'] === 'string' ? object['page_url'] : null;
      if (pageUrl !== null) allowedUrl(pageUrl, domains);
      const commandId = typeof object['command_id'] === 'string' ? object['command_id'] : 'reported-by-broker';
      const receipt: Record<string, JsonValue> = {
        chrome_tab_id: tab?.id ?? -1,
        worker_command_id: commandId,
        ...(pageUrl === null ? {} : { page_url: pageUrl }),
        ...(typeof object['http_status'] === 'number' ? { http_status: object['http_status'] } : {}),
        ...(typeof object['mime_type'] === 'string' ? { mime_type: object['mime_type'] } : {}),
      };
      return { output: safeJson(output), truncated: false, artifacts: artifact === null ? [] : [artifact], receipt_extra: receipt };
    },

    async dispose(): Promise<void> {
      const commands = [...pending.values()];
      pending.clear(); queue.splice(0); active = null;
      for (const command of commands) {
        clearTimeout(command.timer);
        command.reject(new TorosError(ErrorCode.E_CANCELLED, 'Chrome worker stopped', {}));
        await cleanupUpload(command.uploadId);
      }
    },

    createPairingCode(): ChromePairingCode {
      const code = String(randomBytes(4).readUInt32BE(0) % 100_000_000).padStart(8, '0');
      const expiresAt = now().getTime() + PAIRING_TTL_MS;
      pairing = { code, expiresAt, attempts: 0 };
      return { code, expires_at: new Date(expiresAt).toISOString() };
    },

    async pair(code: string, origin: string): Promise<{ readonly token: string; readonly status: ChromeWorkerStatus }> {
      if (!isChromeExtensionOrigin(origin)) fail('Chrome pairing requires a valid extension origin', { worker_code: 'origin_denied' });
      if (pairing === null || now().getTime() >= pairing.expiresAt) fail('Chrome pairing code is absent or expired', { worker_code: 'pairing_expired' });
      pairing.attempts += 1;
      if (pairing.attempts > 10) { pairing = null; fail('Chrome pairing attempt limit reached', { worker_code: 'pairing_locked' }); }
      if (code !== pairing.code) fail('Chrome pairing code is invalid', { worker_code: 'pairing_invalid' });
      const token = randomBytes(32).toString('hex');
      persisted = { version: 1, token_digest: createHash('sha256').update(token).digest('hex'), extension_id: origin.slice('chrome-extension://'.length), paired_at: now().toISOString() };
      pairing = null; extensionVersion = null; lastSeenAt = null; tab = null;
      await persistState();
      return { token, status: adapter.status() };
    },

    authenticate(token: string, origin: string): boolean {
      return persisted !== null && origin === `chrome-extension://${persisted.extension_id}` && equalDigest(token, persisted.token_digest);
    },

    status(): ChromeWorkerStatus {
      return {
        paired: persisted !== null, connected: connected(), extension_id: persisted?.extension_id ?? null,
        extension_version: extensionVersion, paired_at: persisted?.paired_at ?? null, last_seen_at: lastSeenAt,
        tab, allowed_domains: domains, extension_dir: options.extension_dir ?? null,
        queued_commands: queue.length, active_command: active?.command.command_id ?? null,
      };
    },

    poll(input: ChromeWorkerPollInput): { readonly command: ChromeWorkerCommand | null } {
      extensionVersion = boundedString(input.extension_version, 'extension_version', 64);
      lastSeenAt = now().toISOString();
      if (input.tab !== null) {
        if (!Number.isInteger(input.tab.id) || input.tab.id < 0) schema('tab id is invalid');
        const tabUrl = allowedUrl(boundedString(input.tab.url, 'tab.url', 4096), domains).toString();
        tab = { id: input.tab.id, url: tabUrl, title: typeof input.tab.title === 'string' ? input.tab.title.slice(0, 300) : '' };
      } else tab = null;
      if (active !== null) return { command: null };
      const next = queue.shift() ?? null;
      if (next === null) return { command: null };
      next.delivered = true; active = next;
      return { command: next.command };
    },

    async submitResult(input: ChromeWorkerResultInput): Promise<void> {
      const command = finishPending(boundedString(input.command_id, 'command_id', 128));
      if (!input.ok) {
        await cleanupUpload(command.uploadId);
        command.reject(workerError(input.error));
        return;
      }
      const output = input.output ?? {};
      safeJson(output);
      if (command.uploadId !== null) {
        const upload = uploads.get(command.uploadId);
        if (upload === undefined || !upload.completed) {
          await cleanupUpload(command.uploadId);
          command.reject(workerError({ code: 'incomplete_upload', message: 'Download result arrived before upload finalization.' }));
          return;
        }
      }
      const object = typeof output === 'object' && output !== null && !Array.isArray(output)
        ? { ...(output as Record<string, JsonValue>), command_id: command.command.command_id }
        : { value: output, command_id: command.command.command_id };
      command.resolve(object);
    },

    async uploadChunk(input: ChromeUploadChunkInput): Promise<{ readonly accepted: true; readonly bytes: number }> {
      const upload = uploads.get(boundedString(input.upload_id, 'upload_id', 128));
      if (upload === undefined || upload.completed) fail('Unknown or completed Chrome upload', { worker_code: 'upload_invalid' });
      if (!Number.isInteger(input.index) || input.index !== upload.nextIndex) fail('Chrome upload chunk is out of order', { worker_code: 'chunk_order', expected_index: upload.nextIndex });
      if (typeof input.data !== 'string' || input.data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) {
        fail('Chrome upload chunk is not valid bounded base64', { worker_code: 'chunk_invalid' });
      }
      const data = Buffer.from(input.data, 'base64');
      if (data.length > MAX_CHUNK_BYTES) fail('Chrome upload chunk exceeds its byte limit', { worker_code: 'chunk_too_large' });
      if (upload.bytes + data.length > upload.maxBytes) fail('Chrome download exceeds its byte limit', { worker_code: 'download_too_large', max_bytes: upload.maxBytes });
      if (data.length > 0) {
        await appendFile(upload.temporaryPath, data);
        if (upload.header.length < 5) upload.header = Buffer.concat([upload.header, data.subarray(0, 5 - upload.header.length)]);
        upload.hash.update(data); upload.bytes += data.length;
      }
      upload.nextIndex += 1;
      if (input.final) {
        const mime = boundedString(input.mime_type, 'mime_type', 128).toLowerCase().split(';')[0]?.trim() ?? '';
        if (upload.expectedMime !== null && !mime.startsWith(upload.expectedMime)) fail('Chrome download content type did not match', { worker_code: 'mime_mismatch', expected_mime: upload.expectedMime, actual_mime: mime });
        if (typeof input.http_status !== 'number' || !Number.isInteger(input.http_status) || input.http_status < 200 || input.http_status >= 300) fail('Chrome download did not return a successful HTTP status', { worker_code: 'http_failure', http_status: input.http_status ?? null });
        if (upload.bytes === 0) fail('Chrome download was empty', { worker_code: 'empty_download' });
        if (upload.expectedMime?.startsWith('application/pdf') && !upload.header.equals(Buffer.from('%PDF-'))) {
          fail('Chrome download did not contain a PDF signature', { worker_code: 'pdf_magic_mismatch' });
        }
        await rename(upload.temporaryPath, upload.targetPath);
        upload.completed = true; upload.sha256 = upload.hash.digest('hex'); upload.mimeType = mime; upload.httpStatus = input.http_status;
      }
      return { accepted: true, bytes: upload.bytes };
    },
  };

  return adapter;
}
