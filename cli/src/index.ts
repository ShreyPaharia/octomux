#!/usr/bin/env node

import { createTaskCommand } from './commands/create-task.js';
import { listTasksCommand } from './commands/list-tasks.js';
import { getTaskCommand } from './commands/get-task.js';
import { cancelTaskCommand } from './commands/cancel-task.js';

const [command, ...args] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = {
  'create-task': createTaskCommand,
  'list-tasks': listTasksCommand,
  'get-task': getTaskCommand,
  'cancel-task': cancelTaskCommand,
};

async function main() {
  const handler = commands[command];
  if (!handler) {
    console.error('Usage: octomux <command> [options]');
    console.error('');
    console.error('Commands:');
    console.error('  create-task   Create a new task');
    console.error('  list-tasks    List all tasks');
    console.error('  get-task      Get task details');
    console.error('  cancel-task   Cancel a task');
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
