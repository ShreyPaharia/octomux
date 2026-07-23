#!/usr/bin/env node

import { Command } from 'commander';
import { createClient } from './client.js';
import { errorMessage } from './format.js';
import { registerCreateTask } from './commands/create-task.js';
import { registerListTasks } from './commands/list-tasks.js';
import { registerGetTask } from './commands/get-task.js';
import { registerCloseTask } from './commands/close-task.js';
import { registerDeleteTask } from './commands/delete-task.js';
import { registerResumeTask } from './commands/resume-task.js';
import { registerAddAgent } from './commands/add-agent.js';
import { registerStopAgent } from './commands/stop-agent.js';
import { registerSendMessage } from './commands/send-message.js';
import { registerPostReview } from './commands/post-review.js';
import { registerListSkills } from './commands/list-skills.js';
import { registerGetSkill } from './commands/get-skill.js';
import { registerRecentRepos } from './commands/recent-repos.js';
import { registerDefaultBranch } from './commands/default-branch.js';
import { registerTaskMove } from './commands/task-move.js';
import { registerTaskSummary } from './commands/task-summary.js';
import { registerTaskNote } from './commands/task-note.js';
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

registerCreateTask(program);
registerListTasks(program);
registerGetTask(program);
registerCloseTask(program);
registerDeleteTask(program);
registerResumeTask(program);
registerAddAgent(program);
registerStopAgent(program);
registerSendMessage(program);
registerPostReview(program);
registerListSkills(program);
registerGetSkill(program);
registerRecentRepos(program);
registerDefaultBranch(program);
registerTaskMove(program);
registerTaskSummary(program);
registerTaskNote(program);
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
