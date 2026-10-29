/**
 * Config parsing for the agent surface (spec AT): `agents.<name>.token` and
 * `desktop_control.ar_gate_cleared`.
 *
 * Kept process-free (like `desktop-config.ts`) so the strict parsing — in
 * particular the fail-closed `=== true` gate flag and the token shape checks —
 * is testable without constructing a Core or importing `main.ts`, which has an
 * unconditional `main()` side effect at import.
 */

const AGENT_NAMES = ['claude', 'codex'] as const;

/** Extract `agents.claude.token` / `agents.codex.token`, refusing a malformed entry. */
export function agentTokensFromConfig(agents: unknown): { readonly claude?: string; readonly codex?: string } {
  if (agents === undefined || agents === null) return {};
  if (typeof agents !== 'object' || Array.isArray(agents)) {
    throw new Error('agents must be an object');
  }
  const source = agents as Record<string, unknown>;
  const result: { claude?: string; codex?: string } = {};
  for (const name of AGENT_NAMES) {
    const entry = source[name];
    if (entry === undefined) continue;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`agents.${name} must be an object with a token`);
    }
    const token = (entry as Record<string, unknown>)['token'];
    if (typeof token !== 'string') {
      throw new Error(`agents.${name}.token must be a string`);
    }
    result[name] = token;
  }
  return result;
}

/**
 * Strict, fail-closed like `coordinator_enabled` (main.ts): an omitted key,
 * `false`, or a non-boolean (e.g. the string `"true"` from a hand-edited
 * config) all leave the desktop AR gate closed.
 */
export function desktopArGateCleared(desktopControl: unknown): boolean {
  if (typeof desktopControl !== 'object' || desktopControl === null || Array.isArray(desktopControl)) return false;
  return (desktopControl as Record<string, unknown>)['ar_gate_cleared'] === true;
}