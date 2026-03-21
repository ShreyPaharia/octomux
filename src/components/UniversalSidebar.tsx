import { useState, useMemo, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTasks } from '@/lib/hooks';
import { groupTasksForSidebar, type SidebarItem } from '@/lib/sidebar-utils';
import { useOrchestratorContext } from '@/lib/orchestrator-context';

const STORAGE_KEY = 'octomux-sidebar-collapsed';

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

// ─── Status Icons (16x16 inline SVGs) ──────────────────────────────────────

function StatusIcon({ item }: { item: SidebarItem }) {
  const effectiveStatus = item.derivedStatus ?? item.status;

  switch (effectiveStatus) {
    case 'working':
    case 'running':
      return (
        <span
          className="inline-block h-2 w-2 shrink-0 animate-pulse bg-[#22C55E]"
          style={{ borderRadius: '50%' }}
          aria-hidden="true"
        />
      );
    case 'setting_up':
      return (
        <span
          className="inline-block h-2 w-2 shrink-0 animate-pulse"
          style={{ borderRadius: '50%', backgroundColor: '#FFB800' }}
          aria-hidden="true"
        />
      );
    case 'needs_attention':
      return (
        <svg className="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5l6.5 12H1.5L8 1.5z"
            stroke="#FFB800"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <line
            x1="8"
            y1="6"
            x2="8"
            y2="9.5"
            stroke="#FFB800"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.5" r="0.75" fill="#FFB800" />
        </svg>
      );
    case 'error':
      return (
        <span
          className="inline-block h-2 w-2 shrink-0"
          style={{ borderRadius: '50%', backgroundColor: '#EF4444' }}
          aria-hidden="true"
        />
      );
    default:
      return (
        <span
          className="inline-block h-2 w-2 shrink-0"
          style={{ borderRadius: '50%', backgroundColor: '#6a6a6a' }}
          aria-hidden="true"
        />
      );
  }
}

// ─── Nav icons (inline SVGs, 16px) ──────────────────────────────────────────

function DashboardIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

function TerminalIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SettingsIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function UniversalSidebar() {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const { tasks } = useTasks();
  const location = useLocation();
  const { running: orchestratorRunning } = useOrchestratorContext();

  // Extract task ID from URL — useParams doesn't work here since we're outside <Routes>
  const activeTaskId = useMemo(() => {
    const match = location.pathname.match(/^\/tasks\/([^/]+)/);
    return match?.[1] ?? null;
  }, [location.pathname]);

  const groups = useMemo(() => groupTasksForSidebar(tasks), [tasks]);

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

  // Cmd/Ctrl+B keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleCollapsed]);

  // Active nav detection — no nav highlighted when viewing a task
  const activeNav = useMemo(() => {
    if (location.pathname === '/orchestrator') return 'orchestrator';
    if (location.pathname === '/settings') return 'settings';
    if (activeTaskId) return null; // on /tasks/:id — task item highlights instead
    return 'dashboard';
  }, [location.pathname, activeTaskId]);

  const navItems = [
    { key: 'dashboard', label: 'DASHBOARD', to: '/', Icon: DashboardIcon },
    { key: 'orchestrator', label: 'ORCHESTRATOR', to: '/orchestrator', Icon: TerminalIcon },
    { key: 'settings', label: 'SETTINGS', to: '/settings', Icon: SettingsIcon },
  ] as const;

  return (
    <nav
      aria-label="Sidebar"
      className="hidden md:flex flex-col overflow-y-auto overflow-x-hidden transition-[width] duration-150 ease-out"
      style={{
        width: collapsed ? 48 : 240,
        backgroundColor: '#080808',
        borderRight: '1px solid #2f2f2f',
      }}
    >
      {/* Logo row */}
      {collapsed ? (
        <button
          onClick={toggleCollapsed}
          className="flex shrink-0 items-center justify-center py-4 hover:opacity-80"
          style={{ height: 48 }}
          aria-label="Expand sidebar"
        >
          <img
            src="/logo.png"
            alt="octomux"
            className="h-5 w-5"
            style={{
              filter:
                'brightness(0) saturate(100%) invert(45%) sepia(98%) saturate(2000%) hue-rotate(210deg) brightness(100%) contrast(96%)',
            }}
          />
        </button>
      ) : (
        <div
          className="flex shrink-0 items-center justify-between"
          style={{ padding: '24px 20px' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <img
              src="/logo.png"
              alt="octomux"
              className="h-5 w-5"
              style={{
                filter:
                  'brightness(0) saturate(100%) invert(45%) sepia(98%) saturate(2000%) hue-rotate(210deg) brightness(100%) contrast(96%)',
              }}
            />
            <span
              className="font-sans font-semibold text-white"
              style={{ fontSize: 16, letterSpacing: 1 }}
            >
              OCTOMUX
            </span>
            <span style={{ fontSize: 11, color: '#6a6a6a' }}>v2.0</span>
          </div>
          <button
            onClick={toggleCollapsed}
            className="p-1 hover:opacity-80"
            aria-label="Collapse sidebar"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6a6a6a"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>
      )}

      {/* Navigation section */}
      <div style={{ paddingBottom: 24 }}>
        {!collapsed && (
          <div
            className="font-bold uppercase tracking-wider"
            style={{
              fontSize: 10,
              color: '#6a6a6a',
              padding: '0 20px 8px',
            }}
          >
            {'// NAVIGATION'}
          </div>
        )}
        {navItems.map(({ key, label, to, Icon }) => {
          const isActive = activeNav === key;
          const color = isActive ? '#3B82F6' : '#8a8a8a';
          return (
            <Link
              key={key}
              to={to}
              className="flex items-center"
              style={{
                padding: collapsed ? '12px 0' : '12px 20px',
                gap: 12,
                backgroundColor: isActive ? '#3B82F620' : 'transparent',
                color,
                fontWeight: isActive ? 700 : 500,
                fontSize: 13,
                justifyContent: collapsed
                  ? 'center'
                  : key === 'orchestrator'
                    ? 'space-between'
                    : undefined,
              }}
            >
              {collapsed ? (
                <Icon color={color} />
              ) : (
                <>
                  <span className="flex items-center" style={{ gap: 12 }}>
                    <Icon color={color} />
                    {label}
                  </span>
                  {key === 'orchestrator' && orchestratorRunning && (
                    <span
                      className="shrink-0 rounded-full"
                      style={{ width: 6, height: 6, backgroundColor: '#22C55E' }}
                      aria-label="Orchestrator running"
                    />
                  )}
                </>
              )}
            </Link>
          );
        })}
      </div>

      {/* Task groups */}
      <div className="flex-1">
        {groups.map((group) => (
          <div key={group.repo} style={{ paddingBottom: 16 }}>
            {!collapsed && (
              <div
                className="font-bold uppercase tracking-wider"
                style={{
                  fontSize: 10,
                  color: '#6a6a6a',
                  padding: '0 20px 8px',
                }}
              >
                {'// ' + group.repo.toUpperCase()}
              </div>
            )}
            {group.items.map((item) => {
              const isActive = item.id === activeTaskId;
              return (
                <Link
                  key={item.id}
                  to={`/tasks/${item.id}`}
                  aria-current={isActive ? 'page' : undefined}
                  title={collapsed ? item.title : undefined}
                  className="flex items-center"
                  style={{
                    padding: collapsed ? '10px 0' : '10px 20px',
                    gap: 10,
                    backgroundColor: isActive ? '#3B82F620' : 'transparent',
                    justifyContent: collapsed ? 'center' : undefined,
                  }}
                >
                  <StatusIcon item={item} />
                  {!collapsed && (
                    <span
                      className="truncate font-medium"
                      style={{
                        fontSize: 11,
                        color: isActive ? '#3B82F6' : '#8a8a8a',
                      }}
                    >
                      {item.title}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
