import { updateTask } from '../client.js';

export async function closeTaskCommand(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: octomux close-task <id>');
    process.exit(1);
  }

  const task = await updateTask(id, { status: 'closed' });
  console.log(`Task ${task.id} closed.`);
}
