import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

type NavKey = 'home' | 'tasks' | 'reviews' | 'settings';

const NAV_ITEMS: ReadonlyArray<{
  key: NavKey;
  label: string;
  to: string;
  match: (pathname: string) => boolean;
  Icon: (p: { active: boolean }) => ReactNode;
}> = [
  {
    key: 'home',
    label: 'Home',
    to: '/',
    match: (pathname) => pathname === '/',
    Icon: HomeIcon,
  },
  {
    key: 'tasks',
    label: 'Tasks',
    to: '/tasks',
    match: (pathname) => pathname === '/tasks' || pathname.startsWith('/tasks/'),
    Icon: TasksIcon,
  },
  {
    key: 'reviews',
    label: 'Reviews',
    to: '/reviews',
    match: (pathname) => pathname === '/reviews' || pathname.startsWith('/reviews/'),
    Icon: ReviewsIcon,
  },
  {
    key: 'settings',
    label: 'Settings',
    to: '/settings',
    match: (pathname) => pathname === '/settings' || pathname.startsWith('/settings/'),
    Icon: SettingsIcon,
  },
];

function iconStroke(active: boolean): string {
  return active ? '#3B82F6' : 'rgba(255,255,255,0.55)';
}

function HomeIcon({ active }: { active: boolean }) {
  const color = iconStroke(active);
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TasksIcon({ active }: { active: boolean }) {
  const color = iconStroke(active);
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke={color} strokeWidth="2" />
    </svg>
  );
}

function ReviewsIcon({ active }: { active: boolean }) {
  const color = iconStroke(active);
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 11l3 3L22 4" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path
        d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
        stroke={color}
        strokeWidth="2"
      />
    </svg>
  );
}

function SettingsIcon({ active }: { active: boolean }) {
  const color = iconStroke(active);
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke={color} strokeWidth="2" />
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        stroke={color}
        strokeWidth="2"
      />
    </svg>
  );
}

export function MobileBottomNav() {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Mobile navigation"
      data-testid="mobile-bottom-nav"
      className="glass-chrome glass-blur-l1 fixed inset-x-0 bottom-0 z-40 flex border-t border-glass-edge pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {NAV_ITEMS.map(({ key, label, to, match, Icon }) => {
        const active = match(pathname);
        return (
          <Link
            key={key}
            to={to}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            data-testid={`mobile-nav-${key}`}
            className={cn(
              'focus-ring flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium transition-colors',
              active ? 'text-primary' : 'text-muted-soft',
            )}
          >
            <Icon active={active} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
