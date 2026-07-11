// ─── task-engine public facade ───────────────────────────────────────────────
// The single public entry point for the task engine. All external callers
// (routes, poller, teams, services, orchestrator, index.ts) import from here.

export { runSetup } from './setup/index.js';
export {
  isTmuxTargetMissing,
  getActiveWindowIndex,
  getLastWindowIndex,
  cleanupLinkedSessions,
  cleanupOrphanedViewerSessions,
} from './sessions.js';
export {
  scratchRoot,
  scratchDirFor,
  reconcileOrphanSettingUp,
  gcScratchDirs,
} from './reconcile.js';
export {
  validateRepo,
  revParseHead,
  getRemoteOriginUrl,
  hashObject,
  fetchOriginQuiet,
  checkoutRef,
  isAncestor,
  checkDirty,
  gitBranchExists,
  addWorktreeWithBranch,
  slugifyTitle,
} from './git.js';
export {
  buildAgentStartupCommand,
  writeAgentLocalSettings,
  writeWorkerMcpConfig,
  launchAgentWindow,
  computeFreshSessionIds,
  applyOrchestratorMcpConfig,
  prepareResumeLaunch,
} from './launch.js';
export type { AddAgentOpts } from './lifecycle.js';
export {
  preflightWorktree,
  startTask,
  addAgent,
  resumeTask,
  hopAgent,
  respawnAgentFresh,
} from './lifecycle.js';
export { closeTask, softDeleteTask, deleteTask, stopAgent } from './cleanup.js';
export type { UserTerminalResult } from './terminals.js';
export { createUserTerminal, createShellTerminal, closeShellTerminal } from './terminals.js';
export { sendMessageToAgent } from '../tmux-input.js';
