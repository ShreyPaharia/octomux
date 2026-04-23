import type { SidebarGroup } from './sidebar-utils';

export const GROUP_COLLAPSE_PREFIX = 'octomux:sidebar:collapsed:';

/** Read per-group collapsed state from localStorage. Mirrors UniversalSidebar. */
export function isGroupCollapsed(groupKey: string): boolean {
  try {
    return localStorage.getItem(GROUP_COLLAPSE_PREFIX + groupKey) === 'true';
  } catch {
    return false;
  }
}

/** Build a `{groupKey -> collapsed}` map for all groups from localStorage. */
export function readCollapsedGroups(groups: SidebarGroup[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const g of groups) out[g.key] = isGroupCollapsed(g.key);
  return out;
}

/** Flattened list of session IDs that are currently visible (ignores collapsed groups). */
export function visibleSessionIds(
  groups: SidebarGroup[],
  collapsedGroups: Record<string, boolean>,
): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    if (collapsedGroups[group.key]) continue;
    for (const item of group.items) ids.push(item.id);
  }
  return ids;
}

export function getNextSessionId(
  ids: string[],
  currentId: string | null,
  direction: 'next' | 'prev',
): string | null {
  if (ids.length === 0) return null;
  const idx = currentId ? ids.indexOf(currentId) : -1;
  if (idx === -1) {
    return direction === 'next' ? ids[0] : ids[ids.length - 1];
  }
  if (direction === 'next') return ids[(idx + 1) % ids.length];
  return ids[(idx - 1 + ids.length) % ids.length];
}

export function currentTaskIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/tasks\/([^/]+)/);
  return match?.[1] ?? null;
}
