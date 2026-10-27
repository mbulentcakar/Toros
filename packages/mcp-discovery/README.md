# `@toros/mcp-discovery`

A local stdio MCP server (protocol revision **2025-06-18**) that exposes
operator-granted, read-only desktop and machine discovery (spec AT) to a Claude
Code or Codex session. It has **zero runtime dependencies**, holds no policy,
and maps each tool to a fixed Node Core route in a constant table — Node Core
enforces everything even when this server is bypassed.

## Launch

```sh
node <path>/packages/mcp-discovery/dist/src/main.js --agent claude
# …or --agent codex
```

The token is read once from `%LOCALAPPDATA%\Toros\config.json`
(`agents.<agent>.token`) and Node Core's `port` from the same file. No tool
argument can name a URL, port, credential, path, or executable.

## Add to your agent

Claude Code:

```sh
claude mcp add toros-discovery -- node <path>/packages/mcp-discovery/dist/src/main.js --agent claude
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.toros-discovery]
command = "node"
args = ["<path>/packages/mcp-discovery/dist/src/main.js", "--agent", "codex"]
# Only for non-interactive `codex exec` with approval_policy "never": without
# it, Codex refuses every MCP tool call ("requires approval"). Interactive
# sessions can leave it out and approve each call.
default_tools_approval_mode = "approve"
```

Tested (spec AT acceptance 11, 2026-10-27, against a throwaway native node):
Claude Code 2.1.310 and codex-cli 0.160.1 each connected, listed the tools, and
completed `toros_status` and `desktop_state`.

Neither writes a credential into the client's config.

## Driver-profile requirement

The agent's CLI must run under a profile that **cannot read** the Toros config
directory (`%LOCALAPPDATA%\Toros`). Otherwise it could read the other bearers
directly; the config file is not confinement.

## Bounds

- one frame is at most 1 MiB;
- at most 4 JSON-RPC ids may be outstanding;
- each tool call has a 45 s deadline (above Node Core's 30 s action ceiling);
- a Node Core result is at most 1 MiB, refused rather than truncated.

stdout carries protocol frames only; diagnostics go to stderr.