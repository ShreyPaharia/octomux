import type { SidebarItem } from '@/lib/sidebar-utils';
import {
  HomeIcon,
  TasksIcon,
  ReviewsIcon,
  MonitorIcon,
  WorkspacesIcon,
  OrchestratorIcon,
  LoopsIcon,
  SettingsIcon,
  type NavIcon,
} from './glyphs';

// ─── Static config ──────────────────────────────────────────────────────────

export type NavKey = 'home' | 'tasks' | 'reviews' | 'settings';

export const NAV_ITEMS: ReadonlyArray<{
  key: NavKey;
  label: string;
  to: string;
  Icon: NavIcon;
}> = [
  { key: 'home', label: 'Home', to: '/', Icon: HomeIcon },
  { key: 'tasks', label: 'Tasks', to: '/tasks', Icon: TasksIcon },
  { key: 'reviews', label: 'Reviews', to: '/reviews', Icon: ReviewsIcon },
  { key: 'settings', label: 'Settings', to: '/settings', Icon: SettingsIcon },
];

export const MORE_ITEMS = [
  { key: 'monitor', label: 'Monitor', to: '/monitor', Icon: MonitorIcon },
  { key: 'workspaces', label: 'Workspaces', to: '/workspaces', Icon: WorkspacesIcon },
  { key: 'orchestrator', label: 'Orchestrator', to: '/orchestrator', Icon: OrchestratorIcon },
  { key: 'loops', label: 'Loops', to: '/loops', Icon: LoopsIcon },
] as const;

// ─── Fork refusal helper ────────────────────────────────────────────────────

export function forkDisabledReason(item: SidebarItem): string | null {
  if (item.runMode === 'scratch') return 'Cannot fork a scratch task (no repo).';
  if (item.runMode === 'none')
    return 'Cannot fork a task that runs on the working tree (no branch).';
  if (item.status === 'idle') return 'Cannot fork a draft task (no branch yet).';
  return null;
}

// ─── URL builders ───────────────────────────────────────────────────────────

export function buildGroupAddUrl(repoPath: string): string {
  const params = new URLSearchParams({ repo: repoPath, mode: 'new' });
  return `/?${params.toString()}`;
}

export function buildForkUrl(item: SidebarItem): string {
  const params = new URLSearchParams({
    repo: item.repoPath ?? '',
    base_branch: `agents/${item.id}`,
    mode: 'new',
    fork_of: item.id,
  });
  return `/?${params.toString()}`;
}

export function buildAddAgentUrl(taskId: string): string {
  return `/?add_agent=${encodeURIComponent(taskId)}`;
}

// ─── Active-nav derivation (from useLocation in the shell) ──────────────────

export function deriveActiveNav(pathname: string, activeTaskId: string | null): NavKey | null {
  if (pathname === '/settings') return 'settings';
  if (pathname === '/reviews' || pathname.startsWith('/reviews/')) return 'reviews';
  if (pathname === '/tasks' || pathname.startsWith('/tasks/')) return 'tasks';
  if (activeTaskId) return null;
  if (pathname === '/') return 'home';
  return null;
}

export function activeTaskIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/tasks\/([^/]+)/);
  return match?.[1] ?? null;
}
