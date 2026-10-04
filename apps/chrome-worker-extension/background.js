const POLL_ALARM = 'toros-worker-poll';
const POLL_PERIOD_MINUTES = 0.5;
let polling = false;

class WorkerFailure extends Error {
  constructor(code, message, retryAfterSeconds, httpStatus, contentType) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.httpStatus = httpStatus;
    this.contentType = contentType;
  }
}

async function stored() {
  return chrome.storage.local.get(['node_url', 'worker_token', 'tab_id']);
}

function validNodeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function request(path, body, token) {
  const config = await stored();
  if (!validNodeUrl(config.node_url)) throw new WorkerFailure('not_paired', 'Toros Node Core address is not configured.');
  const response = await fetch(`${config.node_url.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let result = null;
  try { result = await response.json(); } catch { result = null; }
  if (!response.ok) {
    throw new WorkerFailure(result?.worker_code ?? result?.error ?? 'node_error', result?.message ?? `Toros returned HTTP ${response.status}.`);
  }
  return result;
}

async function pairedTab() {
  const config = await stored();
  if (!Number.isInteger(config.tab_id)) return null;
  try {
    const tab = await chrome.tabs.get(config.tab_id);
    if (!Number.isInteger(tab.id) || typeof tab.url !== 'string' || !tab.url.startsWith('https://')) return null;
    return { id: tab.id, url: tab.url, title: tab.title ?? '' };
  } catch {
    return null;
  }
}

async function hasOriginPermission(rawUrl) {
  const url = new URL(rawUrl);
  return chrome.permissions.contains({ origins: [`${url.origin}/*`] });
}

async function requireOriginPermission(rawUrl) {
  if (!await hasOriginPermission(rawUrl)) {
    throw new WorkerFailure('permission_required', `Open ${new URL(rawUrl).origin} and grant this site in the Toros extension.`);
  }
}

function waitForTabComplete(tabId, deadlineAt) {
  const remaining = Math.max(1, Date.parse(deadlineAt) - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new WorkerFailure('navigation_timeout', 'Chrome did not finish loading before the command deadline.'));
    }, remaining);
    function listener(id, changeInfo, tab) {
      if (id !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function inspectDocument() {
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const excerpt = normalize(document.body?.innerText ?? '').slice(0, 2500);
  const challenge = /captcha|verify you are human|access denied|unusual traffic|security check|are you a robot/i.test(`${document.title} ${excerpt}`);
  const pageNotFound = /^not found(?:\s*\|.*)?$/i.test(document.title.trim());
  return { url: location.href, title: document.title.slice(0, 300), text_excerpt: excerpt, challenge, page_not_found: pageNotFound };
}

async function extractDocument(fields, documentRules) {
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const inspect = () => {
    const excerpt = normalize(document.body?.innerText ?? '').slice(0, 2500);
    const challenge = /captcha|verify you are human|access denied|unusual traffic|security check|are you a robot/i.test(document.title + ' ' + excerpt);
    const pageNotFound = /^not found(?:\s*\|.*)?$/i.test(document.title.trim());
    return { url: location.href, title: document.title.slice(0, 300), text_excerpt: excerpt, challenge, page_not_found: pageNotFound };
  };
  const fieldValues = {};
  const fieldErrors = {};
  for (const field of fields) {
    try {
      const element = document.querySelector(field.selector);
      fieldValues[field.name] = element === null ? null : normalize(field.attribute ? element.getAttribute(field.attribute) : element.textContent).slice(0, 4000);
    } catch {
      fieldValues[field.name] = null;
      fieldErrors[field.name] = 'invalid selector';
    }
  }

  const anchors = [...document.querySelectorAll('a[href]')].slice(0, 5000).map((anchor) => ({
    text: normalize(anchor.textContent).slice(0, 500),
    url: anchor.href,
  }));
  const documents = [];
  for (const rule of documentRules) {
    const seen = new Set();
    const textTerms = rule.text_contains.map((term) => term.toLowerCase());
    const urlTerms = rule.url_contains.map((term) => term.toLowerCase());
    for (const anchor of anchors) {
      const text = anchor.text.toLowerCase();
      const url = anchor.url.toLowerCase();
      const match = textTerms.some((term) => text.includes(term)) || urlTerms.some((term) => url.includes(term));
      if (!match || seen.has(anchor.url)) continue;
      seen.add(anchor.url);
      documents.push({ kind: rule.kind, url: anchor.url, text: anchor.text });
      if (seen.size >= 20) break;
    }
  }
  return {
    ...inspect(),
    fields: fieldValues,
    field_errors: fieldErrors,
    documents,
  };
}

async function executeScript(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'ISOLATED' });
  const value = results[0]?.result;
  if (value === undefined || value === null) throw new WorkerFailure('page_unavailable', 'Chrome could not inspect the paired page.');
  return value;
}

async function navigate(command, tab) {
  const url = command.payload.url;
  if (typeof url !== 'string') throw new WorkerFailure('invalid_command', 'Navigation URL is missing.');
  await requireOriginPermission(url);
  const completion = waitForTabComplete(tab.id, command.deadline_at);
  await chrome.tabs.update(tab.id, { url });
  const loaded = await completion;
  if (typeof loaded.url !== 'string') throw new WorkerFailure('page_unavailable', 'Chrome returned no loaded URL.');
  await requireOriginPermission(loaded.url);
  const waitMs = Number.isInteger(command.payload.wait_ms) ? Math.max(0, Math.min(15000, command.payload.wait_ms)) : 1500;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const output = await executeScript(tab.id, inspectDocument);
  if (output.challenge) throw new WorkerFailure('challenge', 'Chrome reached a challenge or access-check page. Complete it in the paired tab, then resume the acquisition.');
  return output;
}

async function extract(command, tab) {
  await requireOriginPermission(tab.url);
  const fields = Array.isArray(command.payload.fields) ? command.payload.fields : [];
  const documents = Array.isArray(command.payload.documents) ? command.payload.documents : [];
  const output = await executeScript(tab.id, extractDocument, [fields, documents]);
  if (output.challenge) throw new WorkerFailure('challenge', 'Chrome reached a challenge or access-check page. Complete it in the paired tab, then resume the acquisition.');
  return output;
}

function retryAfterSeconds(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

async function download(command, token) {
  const { url, upload_id: uploadId, max_bytes: maxBytes, chunk_bytes: chunkBytes, expected_mime: expectedMime } = command.payload;
  if (typeof url !== 'string' || typeof uploadId !== 'string') throw new WorkerFailure('invalid_command', 'Download command is incomplete.');
  await requireOriginPermission(url);
  const response = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
  const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream').toLowerCase();
  if (response.status === 429) throw new WorkerFailure('rate_limited', 'The site returned HTTP 429.', retryAfterSeconds(response), response.status, mimeType);
  if (response.status === 401 || response.status === 403) throw new WorkerFailure('access_denied', 'The site returned HTTP ' + response.status + '. Sign in or resolve access in the paired tab, then resume.', undefined, response.status, mimeType);
  if (!response.ok) throw new WorkerFailure('http_failure', 'The document request returned HTTP ' + response.status + '.', undefined, response.status, mimeType);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new WorkerFailure('download_too_large', 'The document exceeds the configured byte limit.', undefined, response.status, mimeType);
  if (typeof expectedMime === 'string' && !mimeType.startsWith(expectedMime.toLowerCase())) throw new WorkerFailure('mime_mismatch', 'Expected ' + expectedMime + ', received ' + mimeType + '.', undefined, response.status, mimeType);
  if (!response.body) throw new WorkerFailure('empty_download', 'The document response had no body.', undefined, response.status, mimeType);
  const reader = response.body.getReader();
  const chunkLimit = Math.max(1024, Math.min(256 * 1024, Number(chunkBytes) || 256 * 1024));
  let carry = new Uint8Array(0);
  let index = 0;
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      const combined = new Uint8Array(carry.length + value.length);
      combined.set(carry); combined.set(value, carry.length); carry = combined;
      while (carry.length >= chunkLimit) {
        const piece = carry.slice(0, chunkLimit); carry = carry.slice(chunkLimit); total += piece.length;
        if (total > maxBytes) throw new WorkerFailure('download_too_large', 'The document exceeds the configured byte limit.', undefined, response.status, mimeType);
        await request('/chrome-worker/upload', { upload_id: uploadId, index, data: base64(piece), final: false }, token); index += 1;
      }
    }
    if (done) break;
  }
  if (carry.length > 0) {
    total += carry.length;
    if (total > maxBytes) throw new WorkerFailure('download_too_large', 'The document exceeds the configured byte limit.', undefined, response.status, mimeType);
    await request('/chrome-worker/upload', { upload_id: uploadId, index, data: base64(carry), final: false }, token); index += 1;
  }
  await request('/chrome-worker/upload', { upload_id: uploadId, index, data: '', final: true, mime_type: mimeType, http_status: response.status }, token);
  return { url: response.url, http_status: response.status, mime_type: mimeType, bytes: total, upload_id: uploadId };
}
async function runCommand(command, token, tab) {
  try {
    let output;
    if (command.action === 'navigate') output = await navigate(command, tab);
    else if (command.action === 'extract') output = await extract(command, tab);
    else if (command.action === 'download') output = await download(command, token);
    else throw new WorkerFailure('unknown_action', `Unknown Toros action: ${command.action}`);
    await request('/chrome-worker/result', { command_id: command.command_id, ok: true, output }, token);
  } catch (error) {
    const failure = error instanceof WorkerFailure ? error : new WorkerFailure('worker_failed', error instanceof Error ? error.message : String(error));
    await request('/chrome-worker/result', { command_id: command.command_id, ok: false, error: { code: failure.code, message: failure.message, ...(Number.isFinite(failure.retryAfterSeconds) ? { retry_after_seconds: failure.retryAfterSeconds } : {}), ...(Number.isInteger(failure.httpStatus) ? { http_status: failure.httpStatus } : {}), ...(typeof failure.contentType === 'string' ? { content_type: failure.contentType.slice(0, 128) } : {}) } }, token).catch(() => undefined);
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const config = await stored();
    if (typeof config.worker_token !== 'string') return;
    const tab = await pairedTab();
    const response = await request('/chrome-worker/poll', { extension_version: chrome.runtime.getManifest().version, tab }, config.worker_token);
    if (response?.command && tab !== null) {
      await runCommand(response.command, config.worker_token, tab);
      setTimeout(() => { void poll(); }, 250);
    }
  } finally {
    polling = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === 'pair') {
      if (!validNodeUrl(message.node_url)) throw new WorkerFailure('invalid_node', 'Use a loopback Node Core address such as http://127.0.0.1:8787/.');
      await chrome.storage.local.set({ node_url: message.node_url, tab_id: message.tab_id });
      const paired = await request('/chrome-worker/pair', { code: message.code }, null);
      await chrome.storage.local.set({ worker_token: paired.token });
      chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
      await poll();
      return { ok: true };
    }
    if (message?.type === 'select_tab') {
      await chrome.storage.local.set({ tab_id: message.tab_id });
      await poll();
      return { ok: true };
    }
    if (message?.type === 'poll') { await poll(); return { ok: true }; }
    if (message?.type === 'status') {
      const config = await stored();
      return { ok: true, paired: typeof config.worker_token === 'string', tab: await pairedTab(), node_url: config.node_url ?? null };
    }
    return { ok: false, error: 'Unknown extension request.' };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === POLL_ALARM) void poll(); });
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES }); void poll(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES }); void poll(); });
void poll();
