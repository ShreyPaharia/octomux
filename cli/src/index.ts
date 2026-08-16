#!/usr/bin/env node

import { Command } from 'commander';
import { registerCapabilityCommands, TASK_CAPABILITY_META } from '@octomux/capabilities';
import { createClient } from './client.js';
import { errorMessage } from './format.js';
import { registerCloseTask } from './commands/close-task.js';
import { registerResumeTask } from './commands/resume-task.js';
import { registerAddAgent } from './commands/add-agent.js';
import { registerStopAgent } from './commands/stop-agent.js';
import { registerSendMessage } from './commands/send-message.js';
import { registerPostReview } from './commands/post-review.js';
import { registerListSkills } from './commands/list-skills.js';
import { registerGetSkill } from './commands/get-skill.js';
import { registerRecentRepos } from './commands/recent-repos.js';
import { registerDefaultBranch } from './commands/default-branch.js';
import { registerTaskRefAdd } from './commands/task-ref-add.js';
import { registerTaskRefRm } from './commands/task-ref-rm.js';
import { registerTaskUpdates } from './commands/task-updates.js';
import { registerHooksInstall } from './commands/hooks-install.js';
import { registerHooksList } from './commands/hooks-list.js';
import { registerListIntegrations } from './commands/list-integrations.js';
import { registerInit } from './commands/init.js';
import { registerFiles } from './commands/files.js';
import { registerEmit } from './commands/emit.js';
import { registerLearn } from './commands/learn.js';
import { registerRecall } from './commands/recall.js';
import { registerUnlearn } from './commands/unlearn.js';
import { registerLearnForget } from './commands/learn-forget.js';
import { registerLearningsDigest } from './commands/learnings-digest.js';
import { registerLoopStart } from './commands/loop-start.js';
import { registerLoopStartGroup } from './commands/loop-start-group.js';
import { registerJudgeEmit } from './commands/judge-emit.js';
import { registerPrExtractEmit } from './commands/pr-extract-emit.js';

const program = new Command();

program
  .name('octomux')
  .description('CLI for managing octomux agent tasks')
  .version('0.1.0')
  .option(
    '-s, --server-url <url>',
    'server URL',
    process.env.OCTOMUX_URL || 'http://localhost:7777',
  )
  .option('--json', 'output as JSON (auto-enabled when piped)');

// Registry-generated `task` commands (list/get/create/start/move/delete) —
// see @octomux/capabilities/cli.js. Flags are derived from each capability's
// zod input schema, so this can never drift from the server's own validation.
registerCapabilityCommands(program, TASK_CAPABILITY_META);

registerCloseTask(program);
registerResumeTask(program);
registerAddAgent(program);
registerStopAgent(program);
registerSendMessage(program);
registerPostReview(program);
registerListSkills(program);
registerGetSkill(program);
registerRecentRepos(program);
registerDefaultBranch(program);
// task-summary / task-note retired with POST /api/tasks/:id/summary and
// /note (spec §5.5) — narrative now lives in the task's
// .octomux/artifact.md, with no CLI write surface in this pass.
registerTaskRefAdd(program);
registerTaskRefRm(program);
registerTaskUpdates(program);
registerHooksInstall(program);
registerHooksList(program);
registerListIntegrations(program);
registerInit(program);
registerFiles(program);
registerEmit(program);
registerLearn(program);
registerRecall(program);
registerUnlearn(program);
registerLearnForget(program);
registerLearningsDigest(program);
registerLoopStart(program);
registerLoopStartGroup(program);
registerJudgeEmit(program);
registerPrExtractEmit(program);

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  const client = createClient(opts.serverUrl);
  thisCommand.setOptionValue('_client', client);
});

program.parseAsync().catch((err) => {
  errorMessage(err.message);
  process.exit(1);
});
