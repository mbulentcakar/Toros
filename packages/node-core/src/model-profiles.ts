/**
 * Operator-visible Hermes models routed through the configured OpenAI-compatible
 * provider. IDs were checked against OpenRouter's live catalogue on 2026-09-01.
 * Keeping the list explicit makes selection bounded and auditable.
 */
export const MODEL_PROFILES = [
  { id: 'openai/gpt-5.6-sol', label: 'Sol', provider: 'OpenAI' },
  { id: 'openai/gpt-5.6-terra', label: 'Terra', provider: 'OpenAI' },
  { id: 'openai/gpt-5.6-luna', label: 'Luna', provider: 'OpenAI' },
  { id: 'anthropic/claude-opus-5', label: 'Opus', provider: 'Anthropic' },
  { id: 'anthropic/claude-sonnet-5', label: 'Sonnet', provider: 'Anthropic' },
  { id: 'x-ai/grok-4.6', label: 'Grok', provider: 'xAI' },
  { id: 'google/gemini-3.7-flash', label: 'Gemini', provider: 'Google' },
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi', provider: 'Moonshot AI' },
  { id: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek', provider: 'DeepSeek' },
  { id: 'z-ai/glm-5.3', label: 'GLM', provider: 'Z.ai' },
] as const;

export function hasModelProfile(id: string): boolean {
  return MODEL_PROFILES.some((profile) => profile.id === id);
}
