import { updateTask } from '../client.js';

export async function cancelTaskCommand(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: octomux cancel-task <id>');
    process.exit(1);
  }

  const task = await updateTask(id, { status: 'cancelled' });
  console.log(`Task ${task.id} cancelled.`);
}
