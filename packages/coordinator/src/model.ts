import type { CoordinatorConfig } from './config.js';

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ModelTransport {
  respond(messages: readonly ModelMessage[]): Promise<unknown>;
  /** Usage for the most recently completed response, consumed once. */
  takeUsage?(): ModelUsage | null;
}

export interface ModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpoint(baseUrl: string): string {
  return baseUrl.endsWith('/') ? `${baseUrl}chat/completions` : `${baseUrl}/chat/completions`;
}

export function createModelTransport(config: CoordinatorConfig, request: typeof fetch = globalThis.fetch): ModelTransport {
  let lastUsage: ModelUsage | null = null;
  return {
    async respond(messages): Promise<unknown> {
      const response = await request(endpoint(config.base_url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.api_key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          messages,
          // `json_object`, not `json_schema` with `strict: true`.
          //
          // Strict mode requires `additionalProperties: false` on EVERY object
          // in the schema, including nested ones. An action's `arguments` is an
          // open object by nature — its shape is whatever the target
          // capability declares — so strict mode cannot express it at all. The
          // provider rejects the request outright:
          //
          //   Invalid schema for response_format 'coordinator_response':
          //   In context=(... 'arguments'), 'additionalProperties' is required
          //   to be supplied and to be false.
          //
          // Encoding `arguments` as a JSON string to satisfy strict mode would
          // buy a provider-side guarantee at the cost of a second parse and a
          // second failure mode, for a field we validate ourselves anyway.
          //
          // The real gate is `parseCoordinatorResponse` from @toros/envelope,
          // which SPEC §5 requires and which this loop already runs on every
          // response: two consecutive failures end the run. Provider-side
          // schema enforcement was a convenience on top of that, never the
          // control — and a control that cannot represent the contract is not
          // one.
          response_format: { type: 'json_object' },
          // `parallel_tool_calls: false` is gone with it. It is a tool-calling
          // parameter and this loop does not use tool calling; SPEC §5's "one
          // action per turn" is enforced by the response contract itself, which
          // has a single `action` field, so two actions are unrepresentable.
          // That is a stronger guarantee than a flag the provider may ignore.
        }),
      });
      if (!response.ok) {
        // Carry the provider's reason. A bare status told the operator nothing
        // about which of model id, key, or request shape was wrong, and a 400
        // from a schema the provider will not accept looks identical to a 400
        // from a typo in the model name.
        const detail = await response.text().catch(() => '');
        throw new Error(`model HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
      }
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error('model response is not an object');
      const usage = body['usage'];
      if (isRecord(usage)) {
        const prompt = usage['prompt_tokens'];
        const completion = usage['completion_tokens'];
        const total = usage['total_tokens'];
        const cost = usage['cost'];
        lastUsage = {
          provider: new URL(config.base_url).hostname,
          // Record the operator-selected routing id. Providers may return a
          // canonical snapshot id; that is useful metadata, but it must not
          // make accounting fail the run-binding equality check.
          model: config.model,
          prompt_tokens: typeof prompt === 'number' && Number.isFinite(prompt) ? Math.max(0, Math.trunc(prompt)) : 0,
          completion_tokens: typeof completion === 'number' && Number.isFinite(completion) ? Math.max(0, Math.trunc(completion)) : 0,
          total_tokens: typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0,
          cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
        };
      } else {
        lastUsage = null;
      }
      const choices = body['choices'];
      if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
        throw new Error('model response has no valid choice');
      }
      const message = choices[0]['message'];
      if (!isRecord(message)) throw new Error('model choice has no message');
      const content = message['content'];
      if (typeof content !== 'string') return content;
      try { return JSON.parse(content); }
      catch { return content; }
    },
    takeUsage(): ModelUsage | null {
      const usage = lastUsage;
      lastUsage = null;
      return usage;
    },
  };
}
