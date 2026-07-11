export type { AddAgentOpts } from './types.js';
export { preflightWorktree, startTask } from './start-task.js';
export {
  addAgent,
  validateAndResolveAddAgentOpts,
  prepareAddAgentLaunch,
  launchAddAgentWindow,
  persistAddAgentRow,
} from './add-agent.js';
export type { ResolvedAddAgentOpts, PreparedAddAgentLaunch } from './add-agent.js';
export {
  resumeTask,
  validateResumeTask,
  prepareResumeSession,
  bootstrapResumeHooks,
  relaunchStoppedAgents,
} from './resume-task.js';
export { hopAgent } from './hop-agent.js';
export { respawnAgentFresh } from './respawn-agent.js';
