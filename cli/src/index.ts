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
import { registerListSkills } from './commands/list-skills.js';
import { registerGetSkill } from './commands/get-skill.js';
import { registerCreateSkill } from './commands/create-skill.js';
import { registerDeleteSkill } from './commands/delete-skill.js';
import { registerRecentRepos } from './commands/recent-repos.js';
import { registerDefaultBranch } from './commands/default-branch.js';

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
registerListSkills(program);
registerGetSkill(program);
registerCreateSkill(program);
registerDeleteSkill(program);
registerRecentRepos(program);
registerDefaultBranch(program);

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  const client = createClient(opts.serverUrl);
  thisCommand.setOptionValue('_client', client);
});

program.parseAsync().catch((err) => {
  errorMessage(err.message);
  process.exit(1);
});
