import { listTasks } from '../client.js';

export async function listTasksCommand(args: string[]): Promise<void> {
  let statusFilter = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status') {
      statusFilter = args[++i] || '';
    }
  }

  let tasks = await listTasks();

  if (statusFilter) {
    tasks = tasks.filter((t) => t.status === statusFilter);
  }

  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  // Simple table output
  const header = 'ID           STATUS       TITLE';
  console.log(header);
  console.log('-'.repeat(header.length + 20));
  for (const t of tasks) {
    console.log(`${t.id.padEnd(13)}${t.status.padEnd(13)}${t.title}`);
  }
}
