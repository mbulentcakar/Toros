import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import {
  ErrorCode,
  TorosError,
  isTerminal,
  type JobRecord,
  type JsonValue,
  type Store,
  type Workspace,
} from '@toros/contracts';
import type { ChromeWorkerStatus } from '@toros/adapters-chrome';

import type {
  BrowserAcquisitionInput,
  BrowserAcquisitionRecord,
  BrowserAcquisitionState,
  BrowserDocumentRule,
  BrowserDocumentState,
  BrowserFieldRule,
  BrowserItemState,
  BrowserSiteProfile,
} from './browser-acquisition-types.js';

export type {
  BrowserAcquisitionDocument,
  BrowserAcquisitionInput,
  BrowserAcquisitionItem,
  BrowserAcquisitionRecord,
  BrowserAcquisitionSource,
  BrowserAcquisitionState,
  BrowserDocumentRule,
  BrowserDocumentState,
  BrowserFieldRule,
  BrowserItemState,
  BrowserSiteProfile,
} from './browser-acquisition-types.js';

interface MutableDocument {
  kind: string; url: string | null; text: string; state: BrowserDocumentState; outcome: string;
  http_status: number | null; content_type: string | null; path: string | null;
  sha256: string | null; bytes: number | null; duplicate_of: string | null; error: string | null;
}
interface MutableItem {
  item_id: string; manifest_index: number; url: string; final_url: string | null; page_outcome: string;
  page_http_status: number | null; product_title: string | null;
  retry_after_seconds: number | null; error_code: string | null;
  state: BrowserItemState; attempts: number; fields: Record<string, string | null>; documents: MutableDocument[];
  started_at: string | null; ended_at: string | null; error: string | null;
}
interface MutableAcquisition {
  acquisition_id: string; name: string; workspace_id: string; site_profile: BrowserSiteProfile; job_id: string;
  state: BrowserAcquisitionState; current_item: number; created_at: string; updated_at: string;
  next_run_at: string | null; error: string | null; manifest_path: string;
  fields: BrowserFieldRule[]; document_rules: BrowserDocumentRule[];
  min_delay_seconds: number; max_delay_seconds: number; max_attempts: number;
  max_backoff_minutes: number; max_consecutive_rate_limits: number; consecutive_rate_limits: number;
  max_document_bytes: number; items: MutableItem[];
}
interface PersistedAcquisitions { readonly version: 1; readonly acquisitions: readonly MutableAcquisition[] }

interface ActionResponse {
  readonly output: string;
  readonly artifacts: readonly string[];
}

interface BrowserAcquisitionDeps {
  readonly db_path: string;
  readonly workspaces: readonly Workspace[];
  readonly allowed_domains: () => readonly string[];
  readonly worker_status: () => ChromeWorkerStatus;
  readonly store: () => Store;
  readonly create_job: (args: Readonly<Record<string, JsonValue>>) => Promise<JobRecord>;
  readonly invoke_action: (job: JobRecord, workspaceId: string, actionId: 'navigate' | 'extract' | 'download', parameters: Readonly<Record<string, JsonValue>>) => Promise<ActionResponse>;
}

const RECONCILE_MS = 1_000;
const MAX_ITEMS = 100;
const MAX_FIELDS = 20;
const MAX_DOCUMENT_RULES = 6;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
// Windows refuses to rename onto a file any other handle has open (a viewer, the cockpit, Defender,
// the search indexer). Those holds are brief, so the atomic replace retries with a bounded backoff.
const REPLACE_ATTEMPTS = 10;
const REPLACE_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function now(): string { return new Date().toISOString(); }
function fail(message: string): never { throw new TorosError(ErrorCode.E_SCHEMA, message, {}); }
function publicRecord(value: MutableAcquisition): BrowserAcquisitionRecord { return JSON.parse(JSON.stringify(value)) as BrowserAcquisitionRecord; }
function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function bounded(value: string, name: string, max: number): string {
  const out = value.trim();
  if (out.length === 0 || Buffer.byteLength(out, 'utf8') > max) fail(`${name} is invalid`);
  return out;
}
function safeSegment(value: string): string {
  const cleaned = value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || 'item';
}
function allowedUrl(raw: string, domains: readonly string[]): string {
  let url: URL;
  try { url = new URL(raw); } catch { fail(`invalid source URL: ${raw}`); }
  if (url.protocol !== 'https:') fail('browser acquisitions permit HTTPS URLs only');
  const host = url.hostname.toLowerCase();
  if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) fail(`source domain is not allowlisted: ${host}`);
  url.username = ''; url.password = '';
  return url.toString();
}
function asObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function delayMs(minSeconds: number, maxSeconds: number): number {
  return Math.round((minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1_000);
}
async function replaceFile(temporary: string, path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try { await rename(temporary, path); return; }
    catch (error: unknown) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (process.platform !== 'win32' || typeof code !== 'string' || !REPLACE_RETRY_CODES.has(code) || attempt >= REPLACE_ATTEMPTS) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * 2 ** (attempt - 1))));
    }
  }
}

export class BrowserAcquisitionController {
  private readonly acquisitions = new Map<string, MutableAcquisition>();
  private readonly statePath: string | null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private saving: Promise<void> = Promise.resolve();
  private readonly manifestWrites = new Map<string, Promise<void>>();
  /** Acquisitions whose latest state could not be persisted; reconcile writes them again. */
  private readonly unpersisted = new Set<string>();

  constructor(private readonly deps: BrowserAcquisitionDeps) {
    this.statePath = deps.db_path === ':memory:' ? null : `${deps.db_path}.browser-acquisitions.json`;
  }

  async start(): Promise<void> {
    if (this.statePath !== null) {
      try {
        const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedAcquisitions;
        if (parsed.version !== 1 || !Array.isArray(parsed.acquisitions)) fail('browser acquisition state has an unsupported format');
        const recovered: MutableAcquisition[] = [];
        for (const acquisition of parsed.acquisitions) {
          // Profiles other than 'generic' were removed; a recovered run continues as generic.
          acquisition.site_profile = 'generic';
          acquisition.max_consecutive_rate_limits ??= 2;
          acquisition.consecutive_rate_limits ??= 0;
          acquisition.items.forEach((item: MutableItem, index: number) => {
            item.manifest_index ??= index; item.final_url ??= null; item.page_outcome ??= 'not_started';
            item.page_http_status ??= null; item.product_title ??= null;
            item.retry_after_seconds ??= null; item.error_code ??= null;
            item.documents.forEach((document: MutableDocument) => {
              document.outcome ??= document.state === 'completed' ? 'downloaded' : document.state;
              document.http_status ??= null; document.content_type ??= null; document.duplicate_of ??= null;
            });
          });
          if (acquisition.state === 'running' || acquisition.state === 'waiting') {
            acquisition.state = 'paused'; acquisition.error = 'Node Core restarted. Review the paired tab, then resume.'; acquisition.next_run_at = null;
            const item = acquisition.items[acquisition.current_item];
            if (item?.state === 'running') { item.state = 'paused'; item.error = acquisition.error; }
            recovered.push(acquisition);
          }
          this.acquisitions.set(acquisition.acquisition_id, acquisition);
        }
        await this.save();
        for (const acquisition of recovered) await this.writeManifest(acquisition);
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    this.timer = setInterval(() => { void this.reconcile().catch((error: unknown) => console.error('browser acquisition reconcile failed', error)); }, RECONCILE_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flushUnpersisted();
    await Promise.all([this.saving, ...this.manifestWrites.values()].map((write) => write.catch(() => undefined)));
  }

  list(): readonly BrowserAcquisitionRecord[] {
    return [...this.acquisitions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(publicRecord);
  }

  async create(input: BrowserAcquisitionInput): Promise<BrowserAcquisitionRecord> {
    const name = bounded(input.name, 'name', 200);
    const workspace = this.deps.workspaces.find((candidate) => candidate.id === input.workspace_id);
    if (workspace === undefined) fail(`unknown workspace: ${input.workspace_id}`);
    const profile: BrowserSiteProfile = input.site_profile === 'generic' ? 'generic' : fail('site_profile is invalid');
    if (input.sources.length < 1 || input.sources.length > MAX_ITEMS) fail(`sources must contain 1 to ${MAX_ITEMS} items`);
    if (input.fields.length > MAX_FIELDS) fail(`fields may contain at most ${MAX_FIELDS} rules`);
    if (input.documents.length < 1 || input.documents.length > MAX_DOCUMENT_RULES) fail(`documents must contain 1 to ${MAX_DOCUMENT_RULES} rules`);
    const domains = this.deps.allowed_domains();
    const ids = new Set<string>();
    const items: MutableItem[] = input.sources.map((source, index) => {
      const itemId = bounded(source.item_id, 'item_id', 120);
      if (ids.has(itemId)) fail(`duplicate item_id: ${itemId}`);
      ids.add(itemId);
      return {
        item_id: itemId, manifest_index: index, url: allowedUrl(source.url, domains),
        final_url: null, page_outcome: 'not_started', page_http_status: null, product_title: null,
        retry_after_seconds: null, error_code: null,
        state: 'pending', attempts: 0, fields: {}, documents: [], started_at: null, ended_at: null, error: null,
      };
    });    const fields = input.fields.map((field) => ({
      name: bounded(field.name, 'field.name', 64), selector: bounded(field.selector, 'field.selector', 256),
      ...(field.attribute === undefined ? {} : { attribute: bounded(field.attribute, 'field.attribute', 64) }),
    }));
    const documentRules = input.documents.map((rule) => ({
      kind: bounded(rule.kind, 'document.kind', 64),
      text_contains: rule.text_contains.map((term) => bounded(term, 'document.text_contains', 80)).slice(0, 8),
      url_contains: rule.url_contains.map((term) => bounded(term, 'document.url_contains', 120)).slice(0, 8),
      required: rule.required,
      max_files: integer(rule.max_files, 'document.max_files', 1, 5),
    }));
    const minDelay = integer(input.min_delay_seconds, 'min_delay_seconds', 1, 3600);
    const maxDelay = integer(input.max_delay_seconds, 'max_delay_seconds', minDelay, 7200);
    const maxAttempts = integer(input.max_attempts, 'max_attempts', 1, 10);
    const maxBackoff = integer(input.max_backoff_minutes, 'max_backoff_minutes', 1, 1440);
    const maxConsecutiveRateLimits = integer(input.max_consecutive_rate_limits, 'max_consecutive_rate_limits', 1, 5);
    const maxDocumentBytes = integer(input.max_document_bytes, 'max_document_bytes', 1024, MAX_DOCUMENT_BYTES);
    const acquisitionId = randomUUID();
    const job = await this.deps.create_job({
      objective: `Acquire ${items.length} browser item(s) for ${name}.`,
      allowed_capabilities: ['chrome.navigate', 'chrome.extract', 'chrome.download'],
      allowed_workspaces: [workspace.id],
      acceptance: ['Every input has exactly one terminal item record.', 'Every successful PDF has a byte count, SHA-256, and valid PDF signature.', 'SDS, specification, missing-document, HTTP, and rate-limit outcomes remain distinguishable.'],
      forbidden: ['bypass-access-controls', 'read-cookies', 'read-passwords'],
      max_actions: 1000,
      max_retries: Math.max(0, maxAttempts - 1),
      expires_in_hours: 168,
    });
    const createdAt = now();
    const record: MutableAcquisition = {
      acquisition_id: acquisitionId, name, workspace_id: workspace.id, site_profile: profile, job_id: job.job_id, state: 'running', current_item: 0,
      created_at: createdAt, updated_at: createdAt, next_run_at: null, error: null,
      manifest_path: `browser-acquisitions/${acquisitionId}/manifest.json`, fields, document_rules: documentRules,
      min_delay_seconds: minDelay, max_delay_seconds: maxDelay, max_attempts: maxAttempts,
      max_backoff_minutes: maxBackoff, max_consecutive_rate_limits: maxConsecutiveRateLimits, consecutive_rate_limits: 0,
      max_document_bytes: maxDocumentBytes, items,
    };
    this.acquisitions.set(acquisitionId, record);
    await this.saveAndManifest(record);
    return publicRecord(record);
  }

  async pause(id: string): Promise<BrowserAcquisitionRecord> {
    const record = this.require(id);
    if (record.state === 'completed' || record.state === 'stopped') return publicRecord(record);
    record.state = 'paused'; record.error = 'Paused by operator. The current browser action may finish before the pause takes effect.'; record.next_run_at = null; record.updated_at = now();
    const item = record.items[record.current_item]; if (item?.state === 'running') item.state = 'paused';
    await this.saveAndManifest(record); return publicRecord(record);
  }

  async resume(id: string): Promise<BrowserAcquisitionRecord> {
    const record = this.require(id);
    if (record.state !== 'paused') fail(`acquisition is ${record.state}, not paused`);
    const item = record.items[record.current_item];
    if (item?.state === 'paused') item.state = 'pending';
    record.state = 'running'; record.error = null; record.next_run_at = null; record.updated_at = now();
    await this.saveAndManifest(record); return publicRecord(record);
  }

  async stopAcquisition(id: string): Promise<BrowserAcquisitionRecord> {
    const record = this.require(id);
    if (record.state === 'completed' || record.state === 'stopped') return publicRecord(record);
    record.state = 'stopped'; record.error = 'Stopped by operator.'; record.next_run_at = null; record.updated_at = now();
    const item = record.items[record.current_item]; if (item?.state === 'running') item.state = 'paused';
    const job = await this.deps.store().getJob(record.job_id);
    if (job !== null && !isTerminal(job.state)) await this.deps.store().setJobState(job.job_id, 'cancelled');
    await this.saveAndManifest(record); return publicRecord(record);
  }

  private require(id: string): MutableAcquisition {
    const record = this.acquisitions.get(id); if (record === undefined) fail('unknown browser acquisition'); return record;
  }

  private async reconcile(): Promise<void> {
    if (this.busy) return;
    await this.flushUnpersisted();
    const record = [...this.acquisitions.values()].find((candidate) => candidate.state === 'running' || candidate.state === 'waiting');
    if (record === undefined) return;
    if (record.state === 'waiting' && record.next_run_at !== null && Date.now() < Date.parse(record.next_run_at)) return;
    if (!this.deps.worker_status().connected || this.deps.worker_status().tab === null) {
      await this.pauseWith(record, 'Chrome worker is not connected to an allowed tab. Pair or select the target tab, then resume.'); return;
    }
    const item = record.items[record.current_item];
    if (item === undefined) { await this.complete(record); return; }
    this.busy = true;
    try { await this.processItem(record, item); }
    catch (error: unknown) { await this.handleFailure(record, item, error); }
    finally { this.busy = false; }
  }

  private async processItem(record: MutableAcquisition, item: MutableItem): Promise<void> {
    const job = await this.deps.store().getJob(record.job_id);
    if (job === null || isTerminal(job.state)) { await this.pauseWith(record, 'The acquisition job is no longer active.'); return; }
    record.state = 'running'; record.next_run_at = null; record.error = null; record.updated_at = now();
    item.state = 'running'; item.attempts += 1; item.started_at ??= now(); item.error = null; item.error_code = null; item.retry_after_seconds = null;
    await this.saveAndManifest(record);

    const navigation = await this.deps.invoke_action(job, record.workspace_id, 'navigate', { url: item.url, wait_ms: 2000 });
    if (record.state !== 'running') return;
    const page = asObject(JSON.parse(navigation.output), 'Chrome navigation returned invalid output');
    if (page['challenge'] === true) throw new TorosError(ErrorCode.E_ADAPTER_FAILURE, 'Chrome reached a challenge page.', { worker_code: 'challenge' });
    item.final_url = typeof page['url'] === 'string' ? allowedUrl(page['url'], this.deps.allowed_domains()) : item.url;
    item.page_outcome = 'loaded';
    item.page_http_status = typeof page['http_status'] === 'number' ? page['http_status'] : null;
    item.product_title = typeof page['title'] === 'string' ? page['title'].slice(0, 300) : null;

    const extraction = await this.deps.invoke_action(job, record.workspace_id, 'extract', {
      site_profile: record.site_profile,
      fields: record.fields.map((field) => ({
        name: field.name,
        selector: field.selector,
        ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
      })),
      documents: record.document_rules.map((rule) => ({ kind: rule.kind, text_contains: rule.text_contains, url_contains: rule.url_contains, required: rule.required })),
    });
    if (record.state !== 'running') return;
    const extracted = asObject(JSON.parse(extraction.output), 'Chrome extraction returned invalid output');
    const rawFields = asObject(extracted['fields'] ?? {}, 'Chrome fields output is invalid');
    item.fields = Object.fromEntries(record.fields.map((field) => [field.name, typeof rawFields[field.name] === 'string' ? String(rawFields[field.name]).slice(0, 4000) : null]));
    const rawDocuments = Array.isArray(extracted['documents']) ? extracted['documents'] : [];
    const previous = new Map(item.documents.filter((document) => document.url !== null).map((document) => [document.kind + '\n' + document.url, document]));
    const discovered: MutableDocument[] = [];
    for (const rule of record.document_rules) {
      const matches = rawDocuments
        .map((value) => asObject(value, 'Chrome document output is invalid'))
        .filter((value) => value['kind'] === rule.kind && typeof value['url'] === 'string')
        .slice(0, rule.max_files);
      if (rule.required && matches.length === 0) throw new Error('No ' + rule.kind + ' document link was found.');
      if (matches.length === 0) {
        discovered.push({
          kind: rule.kind, url: null, text: '', state: 'not_found', outcome: 'not_found',
          http_status: null, content_type: null, path: null, sha256: null, bytes: null, duplicate_of: null, error: null,
        });
        continue;
      }
      for (const value of matches) {
        const url = allowedUrl(String(value['url']), this.deps.allowed_domains());
        discovered.push(previous.get(rule.kind + '\n' + url) ?? {
          kind: rule.kind, url, text: typeof value['text'] === 'string' ? value['text'].slice(0, 500) : '',
          state: 'pending', outcome: 'pending', http_status: null, content_type: null,
          path: null, sha256: null, bytes: null, duplicate_of: null, error: null,
        });
      }
    }
    item.documents = discovered;
    await this.saveAndManifest(record);

    const workspace = this.deps.workspaces.find((candidate) => candidate.id === record.workspace_id);
    if (workspace === undefined) throw new Error('Acquisition workspace no longer exists.');
    for (let index = 0; index < item.documents.length; index += 1) {
      const document = item.documents[index];
      if (document === undefined || document.state !== 'pending' || document.url === null) continue;
      const filename = safeSegment(document.kind) + '-' + (index + 1) + '.pdf';
      const relativePath = 'browser-acquisitions/' + record.acquisition_id + '/' + safeSegment(item.item_id) + '/' + filename;
      try {
        const result = await this.deps.invoke_action(job, record.workspace_id, 'download', { url: document.url, out_path: relativePath, max_bytes: record.max_document_bytes, expected_mime: 'application/pdf' });
        if (record.state !== 'running') return;
        const output = asObject(JSON.parse(result.output), 'Chrome download returned invalid output');
        const artifactId = result.artifacts[0];
        const artifact = artifactId === undefined ? undefined : (await this.deps.store().listArtifacts(job.job_id)).find((candidate) => candidate.artifact_id === artifactId);
        if (artifact === undefined) throw new Error('Chrome did not record the ' + document.kind + ' artifact.');
        const duplicate = record.items.flatMap((candidate) => candidate.documents).find((candidate) => candidate !== document && candidate.state === 'completed' && candidate.sha256 === artifact.sha256);
        document.state = 'completed'; document.outcome = duplicate === undefined ? 'downloaded' : 'duplicate';
        document.http_status = typeof output['http_status'] === 'number' ? output['http_status'] : null;
        document.content_type = typeof output['mime_type'] === 'string' ? output['mime_type'].slice(0, 128) : null;
        document.path = relative(resolve(workspace.root), resolve(artifact.path)).replaceAll('\\', '/');
        document.sha256 = artifact.sha256; document.bytes = artifact.bytes; document.duplicate_of = duplicate?.path ?? null; document.error = null;
      } catch (error: unknown) {
        const detail = error instanceof TorosError ? error.detail : {};
        const workerCode = typeof detail['worker_code'] === 'string' ? detail['worker_code'] : 'download_failed';
        document.http_status = typeof detail['http_status'] === 'number' ? detail['http_status'] : null;
        document.content_type = typeof detail['content_type'] === 'string' ? detail['content_type'].slice(0, 128) : null;
        document.error = error instanceof Error ? error.message : String(error);
        if (workerCode === 'http_failure' && document.http_status === 404) {
          document.state = 'failed'; document.outcome = 'http_404'; await this.saveAndManifest(record); continue;
        }
        document.outcome = workerCode;
        await this.saveAndManifest(record);
        throw error;
      }
      // Outside the try: a failed write must not relabel bytes that already landed as download_failed.
      await this.saveAndManifest(record);
    }

    item.state = 'completed'; item.ended_at = now(); item.error = null;
    item.error_code = null; item.retry_after_seconds = null;
    record.consecutive_rate_limits = 0;
    record.current_item += 1; record.updated_at = now(); record.error = null;
    if (record.current_item >= record.items.length) { await this.complete(record); return; }
    record.state = 'waiting'; record.next_run_at = new Date(Date.now() + delayMs(record.min_delay_seconds, record.max_delay_seconds)).toISOString();
    await this.persistSettled(record);
  }

  private async handleFailure(record: MutableAcquisition, item: MutableItem, error: unknown): Promise<void> {
    const detail = error instanceof TorosError ? error.detail : {};
    const workerCode = typeof detail['worker_code'] === 'string' ? detail['worker_code'] : 'acquisition_failed';
    const message = error instanceof Error ? error.message : String(error);
    const retryAfterSeconds = typeof detail['retry_after_seconds'] === 'number' ? detail['retry_after_seconds'] : null;
    item.error = message; item.error_code = workerCode; item.retry_after_seconds = retryAfterSeconds;
    if (item.page_outcome === 'not_started') item.page_outcome = workerCode;
    record.error = message; record.updated_at = now();

    if (workerCode === 'rate_limited') {
      record.consecutive_rate_limits += 1;
      if (record.consecutive_rate_limits >= record.max_consecutive_rate_limits) {
        item.state = 'paused'; record.state = 'paused'; record.next_run_at = null;
        record.error = 'Web capture paused after ' + record.consecutive_rate_limits + ' consecutive HTTP 429 responses. Review Retry-After before resuming.';
        await this.saveAndManifest(record); return;
      }
    }
    if (['challenge', 'access_denied', 'permission_required', 'not_connected', 'mime_mismatch', 'pdf_magic_mismatch', 'empty_download'].includes(workerCode)) {
      item.state = 'paused'; record.state = 'paused'; record.next_run_at = null; await this.saveAndManifest(record); return;
    }
    if (item.attempts >= record.max_attempts) {
      item.state = 'paused'; record.state = 'paused'; record.next_run_at = null; record.error = item.item_id + ' exhausted ' + record.max_attempts + ' attempts: ' + message;
      await this.saveAndManifest(record); return;
    }
    const retryAfter = retryAfterSeconds === null ? 0 : retryAfterSeconds * 1_000;
    const exponential = Math.min(record.max_backoff_minutes * 60_000, record.min_delay_seconds * 1_000 * 2 ** Math.max(0, item.attempts - 1));
    const backoff = Math.max(retryAfter, Math.round(exponential * (0.85 + Math.random() * 0.3)));
    item.state = 'pending'; record.state = 'waiting'; record.next_run_at = new Date(Date.now() + backoff).toISOString();
    await this.saveAndManifest(record);
  }
  private async pauseWith(record: MutableAcquisition, reason: string): Promise<void> {
    record.state = 'paused'; record.error = reason; record.next_run_at = null; record.updated_at = now();
    const item = record.items[record.current_item]; if (item?.state === 'running') { item.state = 'paused'; item.error = reason; }
    await this.saveAndManifest(record);
  }

  private async complete(record: MutableAcquisition): Promise<void> {
    // Close the job first: if that fails the record is still running, and the next reconcile
    // reaches complete() again because current_item is past the last item.
    const job = await this.deps.store().getJob(record.job_id);
    if (job !== null && !isTerminal(job.state)) await this.deps.store().setJobState(job.job_id, 'proposed');
    record.state = 'completed'; record.error = null; record.next_run_at = null; record.updated_at = now();
    await this.persistSettled(record);
  }

  /**
   * Persist a record whose item outcome is already settled. A write failure here is not an item
   * attempt: it must never reach handleFailure and reopen a completed item as paused or exhausted.
   * The in-memory record stays authoritative and reconcile writes it again.
   */
  private async persistSettled(record: MutableAcquisition): Promise<void> {
    try { await this.saveAndManifest(record); }
    catch (error: unknown) {
      this.unpersisted.add(record.acquisition_id);
      console.error('browser acquisition state could not be persisted; will retry', record.acquisition_id, error);
    }
  }

  private async flushUnpersisted(): Promise<void> {
    for (const id of [...this.unpersisted]) {
      const record = this.acquisitions.get(id);
      if (record === undefined) { this.unpersisted.delete(id); continue; }
      try { await this.saveAndManifest(record); }
      catch (error: unknown) { console.error('browser acquisition state could not be persisted; will retry', id, error); }
    }
  }

  private async saveAndManifest(record: MutableAcquisition): Promise<void> {
    await this.save();
    await this.writeManifest(record);
    // Both stores now hold this record's latest state (save() writes every acquisition).
    this.unpersisted.delete(record.acquisition_id);
  }

  private async writeManifest(record: MutableAcquisition): Promise<void> {
    const workspace = this.deps.workspaces.find((candidate) => candidate.id === record.workspace_id);
    if (workspace === undefined) return;
    const path = resolve(workspace.root, record.manifest_path);
    const root = resolve(workspace.root);
    if (!(path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`))) fail('acquisition manifest escaped its workspace');
    // Snapshot now and serialise per record, so writes land in call order and the last one wins.
    const data = JSON.stringify(publicRecord(record), null, 2);
    const previous = this.manifestWrites.get(record.acquisition_id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, 'utf8');
      await replaceFile(temporary, path);
    });
    this.manifestWrites.set(record.acquisition_id, write);
    try { await write; }
    finally { if (this.manifestWrites.get(record.acquisition_id) === write) this.manifestWrites.delete(record.acquisition_id); }
  }

  private async save(): Promise<void> {
    if (this.statePath === null) return;
    const data = JSON.stringify({ version: 1, acquisitions: [...this.acquisitions.values()] } satisfies PersistedAcquisitions, null, 2);
    const path = this.statePath;
    // catch() first: one failed write must not reject every later save chained behind it.
    const write = this.saving.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, 'utf8'); await replaceFile(temporary, path);
    });
    this.saving = write;
    await write;
  }
}
