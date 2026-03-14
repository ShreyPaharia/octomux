import type { Task, TaskStatus, DerivedTaskStatus } from '../../server/types';

export interface SidebarItem {
  id: string;
  title: string;
  status: TaskStatus;
  derivedStatus: DerivedTaskStatus | null;
  pendingPromptCount: number;
}

export interface SidebarGroup {
  repo: string;
  items: SidebarItem[];
}

const ACTIVE_STATUSES: TaskStatus[] = ['running', 'setting_up', 'error'];

/** Sort priority: running/setting_up (0), needs_attention (1), error (2), rest (3). */
function sortPriority(item: SidebarItem): number {
  if (item.status === 'error') return 2;
  if (item.derivedStatus === 'needs_attention') return 1;
  if (item.status === 'running' || item.status === 'setting_up') return 0;
  return 3;
}

export function groupTasksForSidebar(tasks: Task[]): SidebarGroup[] {
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));

  const grouped = new Map<string, { items: SidebarItem[]; tasks: Task[] }>();
  for (const task of active) {
    const repo = task.repo_path.split('/').pop() || task.repo_path;
    const item: SidebarItem = {
      id: task.id,
      title: task.title,
      status: task.status,
      derivedStatus: task.derived_status ?? null,
      pendingPromptCount: task.pending_prompts?.length ?? 0,
    };
    const existing = grouped.get(repo);
    if (existing) {
      existing.items.push(item);
      existing.tasks.push(task);
    } else {
      grouped.set(repo, { items: [item], tasks: [task] });
    }
  }

  const groups: SidebarGroup[] = [];
  for (const [repo, { items, tasks: groupTasks }] of grouped) {
    const createdAt = new Map(groupTasks.map((t) => [t.id, t.created_at]));
    items.sort((a, b) => {
      const priorityDiff = sortPriority(a) - sortPriority(b);
      if (priorityDiff !== 0) return priorityDiff;
      return (createdAt.get(b.id) ?? '').localeCompare(createdAt.get(a.id) ?? '');
    });
    groups.push({ repo, items });
  }

  return groups;
}
