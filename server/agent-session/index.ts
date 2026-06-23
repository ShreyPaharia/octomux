export type { SpawnOptions, ProcessHandle, ProcessSubstrate } from './substrate.js';
export { ptySubstrate } from './substrate-pty.js';
export { tmuxSubstrate } from './substrate-tmux.js';
export {
  buildToolDefinition,
  handleSubmitResultCall,
  createSubmitResultServer,
} from './mcp/submit-result-server.js';
export type {
  SubmitResultCallResult,
  CreateSubmitResultServerOpts,
} from './mcp/submit-result-server.js';
export { submitResultServerInvocation, writeSubmitResultMcpConfig } from './mcp/config.js';
export type { WriteSubmitResultMcpConfigOpts } from './mcp/config.js';
