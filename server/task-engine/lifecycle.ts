export type { AddAgentOpts } from './lifecycle/types.js';
export {
  preflightWorktree,
  startTask,
  addAgent,
  resumeTask,
  hopAgent,
  validateAndResolveAddAgentOpts,
  prepareAddAgentLaunch,
  launchAddAgentWindow,
  persistAddAgentRow,
} from './lifecycle/index.js';
