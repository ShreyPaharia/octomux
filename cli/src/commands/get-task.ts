import { getTask } from '../client.js';

export async function getTaskCommand(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: octomux get-task <id>');
    process.exit(1);
  }

  const task = await getTask(id);
  console.log(JSON.stringify(task, null, 2));
}
