import type { IncomingMessage, ServerResponse } from 'node:http';

import { ErrorCode, TorosError } from '@toros/contracts';
import {
  isChromeExtensionOrigin,
  type ChromeUploadChunkInput, type ChromeWorkerAdapter,
  type ChromeWorkerPollInput, type ChromeWorkerResultInput,
} from '@toros/adapters-chrome';

import { asRecord, optionalString, readBody, requiredString, send, toros, type RouteSurface } from './http.js';

export function createChromeRoutes(deps: { readonly getChromeWorker: () => ChromeWorkerAdapter }): RouteSurface {
  return {
    async handle(operation: string | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
      const origin = request.headers.origin;
      if (!isChromeExtensionOrigin(origin)) { send(response, 403, { error: 'Chrome extension origin is required' }); return; }
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'origin');
      if (request.method === 'OPTIONS') {
        response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'authorization, content-type');
        response.writeHead(204); response.end(); return;
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST, OPTIONS');
        send(response, 405, { error: 'Method not allowed' }); return;
      }
      try {
        const worker = deps.getChromeWorker();
        if (operation === 'pair') {
          const args = asRecord(await readBody(request));
          send(response, 200, await worker.pair(requiredString(args, 'code'), origin));
          return;
        }
        const authorization = request.headers.authorization;
        const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!worker.authenticate(token, origin)) { send(response, 401, { error: 'Unauthorized' }); return; }
        const args = asRecord(await readBody(request));
        if (operation === 'poll') {
          const rawTab = args['tab'];
          let tab: ChromeWorkerPollInput['tab'] = null;
          if (rawTab !== null && rawTab !== undefined) {
            const record = asRecord(rawTab);
            const id = record['id'];
            if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) throw toros(ErrorCode.E_SCHEMA, 'tab.id is invalid');
            tab = { id, url: requiredString(record, 'url'), title: optionalString(record, 'title') ?? '' };
          }
          send(response, 200, worker.poll({ extension_version: requiredString(args, 'extension_version'), tab }));
          return;
        }
        if (operation === 'result') {
          if (typeof args['ok'] !== 'boolean') throw toros(ErrorCode.E_SCHEMA, 'ok must be a boolean');
          let error: ChromeWorkerResultInput['error'];
          if (args['error'] !== undefined && args['error'] !== null) {
            const record = asRecord(args['error']);
            const retry = record['retry_after_seconds'];
            if (retry !== undefined && (typeof retry !== 'number' || !Number.isInteger(retry) || retry < 0 || retry > 24 * 60 * 60)) throw toros(ErrorCode.E_SCHEMA, 'retry_after_seconds is invalid');
            error = { code: requiredString(record, 'code'), message: requiredString(record, 'message'), ...(typeof retry === 'number' ? { retry_after_seconds: retry } : {}) };
          }
          const input: ChromeWorkerResultInput = { command_id: requiredString(args, 'command_id'), ok: args['ok'], ...(args['output'] === undefined ? {} : { output: args['output'] }), ...(error === undefined ? {} : { error }) };
          await worker.submitResult(input);
          send(response, 200, { accepted: true });
          return;
        }
        if (operation === 'upload') {
          const index = args['index'];
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw toros(ErrorCode.E_SCHEMA, 'index is invalid');
          if (typeof args['final'] !== 'boolean') throw toros(ErrorCode.E_SCHEMA, 'final must be a boolean');
          const httpStatus = args['http_status'];
          if (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus))) throw toros(ErrorCode.E_SCHEMA, 'http_status is invalid');
          const input: ChromeUploadChunkInput = {
            upload_id: requiredString(args, 'upload_id'), index, data: typeof args['data'] === 'string' ? args['data'] : '', final: args['final'],
            ...(typeof args['mime_type'] === 'string' ? { mime_type: args['mime_type'] } : {}),
            ...(typeof httpStatus === 'number' ? { http_status: httpStatus } : {}),
          };
          send(response, 200, await worker.uploadChunk(input));
          return;
        }
        send(response, 404, { error: 'Not found' });
      } catch (error: unknown) {
        const e = error instanceof TorosError ? error : toros(ErrorCode.E_ADAPTER_FAILURE, error instanceof Error ? error.message : String(error));
        send(response, e.detail['body_too_large'] === true ? 413 : 400, { error: e.code, message: e.message, ...e.detail });
      }
    },
  };
}
