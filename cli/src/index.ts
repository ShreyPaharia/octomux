#!/usr/bin/env node

import { createTaskCommand } from './commands/create-task.js';
import { listTasksCommand } from './commands/list-tasks.js';
import { getTaskCommand } from './commands/get-task.js';
import { closeTaskCommand } from './commands/close-task.js';

const [command, ...args] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = {
  'create-task': createTaskCommand,
  'list-tasks': listTasksCommand,
  'get-task': getTaskCommand,
  'close-task': closeTaskCommand,
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
    console.error('  close-task    Close a task');
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
