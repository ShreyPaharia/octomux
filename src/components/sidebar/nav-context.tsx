import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { GROUP_COLLAPSE_PREFIX, isGroupCollapsed } from '@/lib/sidebar-nav';

// localStorage key for the rail collapse toggle — kept verbatim from the
// original UniversalSidebar so existing user state rehydrates unchanged.
const STORAGE_KEY = 'octomux-sidebar-collapsed';

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export interface NavContextValue {
  /** Whether the rail is collapsed to icon-only width. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Per-group collapse map keyed by group key. */
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapsed: (groupKey: string) => void;
  /** Seed collapse state for any newly-seen group keys from localStorage. */
  syncGroupKeys: (groupKeys: string[]) => void;
}

const NavContext = createContext<NavContextValue | null>(null);

/**
 * Holds the sidebar's shared *persisted* navigation state: the rail collapse
 * toggle and the per-repo-group collapse map. `activeNav`/`activeTaskId` stay
 * derived from `useLocation()` in the shell and are deliberately NOT here.
 */
export function NavProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const toggleGroupCollapsed = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = !prev[groupKey];
      try {
        localStorage.setItem(GROUP_COLLAPSE_PREFIX + groupKey, String(next));
      } catch {
        // ignore
      }
      return { ...prev, [groupKey]: next };
    });
  }, []);

  const syncGroupKeys = useCallback((groupKeys: string[]) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of groupKeys) {
        if (!(key in next)) {
          next[key] = isGroupCollapsed(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const value = useMemo<NavContextValue>(
    () => ({ collapsed, toggleCollapsed, collapsedGroups, toggleGroupCollapsed, syncGroupKeys }),
    [collapsed, toggleCollapsed, collapsedGroups, toggleGroupCollapsed, syncGroupKeys],
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used within NavProvider');
  return ctx;
}
