import type { Task } from '../../server/types';

export function isRegularTask(task: Pick<Task, 'source'>): boolean {
  return task.source !== 'auto_review';
}

export function regularTasksOnly<T extends Pick<Task, 'source'>>(tasks: T[]): T[] {
  return tasks.filter(isRegularTask);
}
