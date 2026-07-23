import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { GlassPanel } from '@/components/ui/glass-panel';
import { PageHeader } from '@/components/layout/page-header';
import { cn } from '@/lib/utils';

export type SettingsScrollSection =
  | 'general'
  | 'hooks'
  | 'repositories'
  | 'reviews'
  | 'editor'
  | 'coding-agent'
  | 'agent-launch'
  | 'schedule-skills'
  | 'advanced';

export const SETTINGS_SCROLL_NAV: { id: SettingsScrollSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'editor', label: 'Editor' },
  { id: 'coding-agent', label: 'Coding agent' },
  { id: 'agent-launch', label: 'Agent launch' },
  { id: 'schedule-skills', label: 'Schedule skills' },
  { id: 'advanced', label: 'Advanced' },
];

export const SETTINGS_ROUTE_NAV: { id: string; label: string; to: string }[] = [
  { id: 'setup', label: 'Setup', to: '/setup' },
  { id: 'integrations', label: 'Integrations', to: '/integrations' },
];

export interface SettingsLayoutProps {
  title: string;
  description?: string;
  activeScrollSection?: SettingsScrollSection;
  onScrollTo?: (id: SettingsScrollSection) => void;
  children: ReactNode;
}

export function SettingsLayout({
  title,
  description,
  activeScrollSection,
  onScrollTo,
  children,
}: SettingsLayoutProps) {
  const { pathname } = useLocation();
  const onRouteNav = SETTINGS_ROUTE_NAV.some((item) => item.to === pathname);

  const scrollNav = (
    <>
      {SETTINGS_SCROLL_NAV.map((item) => {
        const isActive = !onRouteNav && item.id === activeScrollSection;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`settings-nav-${item.id}`}
            data-active={isActive ? 'true' : undefined}
            onClick={() => onScrollTo?.(item.id)}
            className={settingsNavItemClass(isActive, 'sidebar')}
          >
            {item.label}
          </button>
        );
      })}
      <div className="mx-2 my-2 hidden border-t border-glass-edge md:block" role="separator" />
      {SETTINGS_ROUTE_NAV.map((item) => {
        const isActive = item.to === pathname;
        return (
          <Link
            key={item.id}
            to={item.to}
            data-testid={`settings-nav-${item.id}`}
            data-active={isActive ? 'true' : undefined}
            className={settingsNavItemClass(isActive, 'sidebar')}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader variant="glass" title={title} description={description} />

      <GlassPanel
        chrome
        className="shrink-0 overflow-x-auto border-b border-glass-edge px-2 py-2 md:hidden"
      >
        <nav
          aria-label="Settings sections"
          data-testid="settings-mobile-nav"
          className="flex w-max min-w-full gap-1"
        >
          {SETTINGS_SCROLL_NAV.map((item) => {
            const isActive = !onRouteNav && item.id === activeScrollSection;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`settings-mobile-nav-${item.id}`}
                data-active={isActive ? 'true' : undefined}
                onClick={() => onScrollTo?.(item.id)}
                className={settingsNavItemClass(isActive, 'mobile')}
              >
                {item.label}
              </button>
            );
          })}
          {SETTINGS_ROUTE_NAV.map((item) => {
            const isActive = item.to === pathname;
            return (
              <Link
                key={item.id}
                to={item.to}
                data-testid={`settings-mobile-nav-${item.id}`}
                data-active={isActive ? 'true' : undefined}
                className={settingsNavItemClass(isActive, 'mobile')}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </GlassPanel>

      <div className="flex min-h-0 flex-1">
        <GlassPanel
          chrome
          className="hidden w-[220px] shrink-0 flex-col gap-0.5 rounded-none border-y-0 border-l-0 py-4 md:flex"
        >
          <nav aria-label="Settings sections" className="flex flex-col gap-0.5 px-2">
            {scrollNav}
          </nav>
        </GlassPanel>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-6 md:py-6">
          <div className="mx-auto max-w-3xl">{children}</div>
        </div>
      </div>
    </div>
  );
}

function settingsNavItemClass(active: boolean, variant: 'sidebar' | 'mobile'): string {
  if (variant === 'mobile') {
    return cn(
      'focus-ring shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150',
      active
        ? 'bg-primary/15 text-primary'
        : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
    );
  }

  return cn(
    'focus-ring rounded-[10px] px-3 py-2 text-left text-sm font-medium transition-all duration-150',
    active
      ? 'border-l-2 border-primary bg-primary/15 text-primary'
      : 'border-l-2 border-transparent text-muted-foreground hover:bg-white/5 hover:text-foreground',
  );
}
