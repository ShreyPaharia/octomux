import type { Task, DerivedTaskStatus, RunMode, RuntimeState } from '../../server/types';
import { isRegularTask } from './task-filters';
import { repoName } from './utils';

export const OTHER_GROUP_KEY = '__other__';
export const OTHER_GROUP_LABEL = 'Other';

export interface SidebarItem {
  id: string;
  title: string;
  status: RuntimeState;
  derivedStatus: DerivedTaskStatus | null;
  runMode: RunMode;
  repoPath: string | null;
}

export interface SidebarGroup {
  /** Stable key — either the task's `repo_path` or `OTHER_GROUP_KEY` for scratch/repo-less tasks. */
  key: string;
  /** Display label for the group header. */
  repo: string;
  items: SidebarItem[];
}

const ACTIVE_STATUSES: RuntimeState[] = ['running', 'setting_up', 'error'];

/** Sort priority: running/setting_up (0), needs_attention (1), error (2), rest (3). */
function sortPriority(item: SidebarItem): number {
  if (item.status === 'error') return 2;
  if (item.derivedStatus === 'needs_attention') return 1;
  if (item.status === 'running' || item.status === 'setting_up') return 0;
  return 3;
}

function itemFromTask(task: Task): SidebarItem {
  return {
    id: task.id,
    title: task.title,
    status: task.runtime_state,
    derivedStatus: task.derived_status ?? null,
    runMode: task.run_mode,
    repoPath: task.repo_path || null,
  };
}

function groupKeyFor(task: Task): { key: string; label: string } {
  if (task.run_mode === 'scratch' || !task.repo_path) {
    return { key: OTHER_GROUP_KEY, label: OTHER_GROUP_LABEL };
  }
  return { key: task.repo_path, label: repoName(task.repo_path) };
}

export function groupTasksForSidebar(tasks: Task[]): SidebarGroup[] {
  const active = tasks.filter((t) => isRegularTask(t) && ACTIVE_STATUSES.includes(t.runtime_state));

  const grouped = new Map<string, { label: string; items: SidebarItem[]; tasks: Task[] }>();

  for (const task of active) {
    const { key, label } = groupKeyFor(task);
    const item = itemFromTask(task);
    const existing = grouped.get(key);
    if (existing) {
      existing.items.push(item);
      existing.tasks.push(task);
    } else {
      grouped.set(key, { label, items: [item], tasks: [task] });
    }
  }

  const groups: SidebarGroup[] = [];
  for (const [key, { label, items, tasks: groupTasks }] of grouped) {
    const createdAt = new Map(groupTasks.map((t) => [t.id, t.created_at]));
    items.sort((a, b) => {
      const priorityDiff = sortPriority(a) - sortPriority(b);
      if (priorityDiff !== 0) return priorityDiff;
      return (createdAt.get(b.id) ?? '').localeCompare(createdAt.get(a.id) ?? '');
    });
    groups.push({ key, repo: label, items });
  }

  groups.sort((a, b) => {
    // "Other" always sorts last.
    if (a.key === OTHER_GROUP_KEY) return 1;
    if (b.key === OTHER_GROUP_KEY) return -1;
    return a.repo.localeCompare(b.repo);
  });
  return groups;
}
