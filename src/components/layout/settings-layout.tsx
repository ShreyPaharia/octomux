import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { GlassPanel } from '@/components/ui/glass-panel';
import { PageHeader } from '@/components/layout/page-header';
import { cn } from '@/lib/utils';

export type SettingsScrollSection =
  | 'general'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'repositories'
  | 'editor'
  | 'coding-agent'
  | 'agent-launch';

export const SETTINGS_SCROLL_NAV: { id: SettingsScrollSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'editor', label: 'Editor' },
  { id: 'coding-agent', label: 'Coding agent' },
  { id: 'agent-launch', label: 'Agent launch' },
];

export const SETTINGS_ROUTE_NAV: { id: 'integrations'; label: string; to: string }[] = [
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
  const onIntegrations = pathname === '/integrations';

  return (
    <div className="flex h-full flex-col">
      <PageHeader variant="glass" title={title} description={description} />

      <div className="flex min-h-0 flex-1">
        <GlassPanel
          chrome
          className="flex w-[220px] shrink-0 flex-col gap-0.5 rounded-none border-y-0 border-l-0 py-4"
        >
          <nav aria-label="Settings sections" className="flex flex-col gap-0.5 px-2">
            {SETTINGS_SCROLL_NAV.map((item) => {
              const isActive = !onIntegrations && item.id === activeScrollSection;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  data-active={isActive ? 'true' : undefined}
                  onClick={() => onScrollTo?.(item.id)}
                  className={settingsNavItemClass(isActive)}
                >
                  {item.label}
                </button>
              );
            })}
            <div className="mx-2 my-2 border-t border-glass-edge" role="separator" />
            {SETTINGS_ROUTE_NAV.map((item) => {
              const isActive = item.to === pathname;
              return (
                <Link
                  key={item.id}
                  to={item.to}
                  data-testid={`settings-nav-${item.id}`}
                  data-active={isActive ? 'true' : undefined}
                  className={settingsNavItemClass(isActive)}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </GlassPanel>

        <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
          <div className="mx-auto max-w-3xl">{children}</div>
        </div>
      </div>
    </div>
  );
}

function settingsNavItemClass(active: boolean): string {
  return cn(
    'focus-ring rounded-[10px] px-3 py-2 text-left text-sm font-medium transition-all duration-150',
    active
      ? 'border-l-2 border-primary bg-primary/15 text-primary'
      : 'border-l-2 border-transparent text-muted-foreground hover:bg-white/5 hover:text-foreground',
  );
}
