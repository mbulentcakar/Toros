/**
 * @toros/mcp-discovery — the local stdio MCP server for read-only discovery.
 *
 * Re-exports for tests and consumers. `main.ts` is the launch entry and is
 * deliberately not re-exported here (it has a `main()` side effect at import).
 */

export {
  createMcpServer,
  DEFAULT_DEADLINE_MS,
  FRAME_CAP_BYTES,
  MAX_OUTSTANDING,
  PROTOCOL_VERSION,
  NODE_CORE_DEADLINE,
  RESULT_EXCEEDS_CAP,
  type CallResult,
  type CoreCall,
  type CoreCallFailure,
  type McpServer,
  type McpServerOptions,
  type ToolCallArgs,
} from './protocol.js';

export {
  createCoreClient,
  RESULT_CAP_BYTES,
  type CoreClientOptions,
} from './core-client.js';

export {
  configPath,
  readConfig,
  type AgentName,
  type McpConfig,
} from './config.js';