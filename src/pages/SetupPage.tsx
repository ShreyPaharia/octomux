import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SetupItem, type SetupStatusResponse } from '@/lib/api';
import { showToast } from '@/components/CustomToast';
import { PageHeader } from '@/components/layout/page-header';
import { SectionCard } from '@/components/layout/section-card';
import { SettingRow } from '@/components/layout/setting-row';
import { Button } from '@/components/ui/button';
import { ROW_DIVIDER } from '@/lib/design-tokens';

const CATEGORY_ORDER = ['required', 'recommended', 'optional'] as const;
const CATEGORY_LABELS: Record<(typeof CATEGORY_ORDER)[number], string> = {
  required: 'Required',
  recommended: 'Recommended',
  optional: 'Optional',
};

function statusLabel(status: SetupItem['status']): string {
  switch (status) {
    case 'ok':
      return 'Ready';
    case 'missing':
      return 'Missing';
    case 'outdated':
      return 'Outdated';
    case 'unconfigured':
      return 'Not configured';
    case 'optional_missing':
      return 'Optional';
    default:
      return status;
  }
}

function statusClass(status: SetupItem['status']): string {
  switch (status) {
    case 'ok':
      return 'text-[#22C55E]';
    case 'missing':
    case 'outdated':
      return 'text-red-400';
    case 'unconfigured':
      return 'text-[#FFB800]';
    default:
      return 'text-[#8a8a8a]';
  }
}

function SetupItemRow({
  item,
  installing,
  onInstall,
}: {
  item: SetupItem;
  installing: string | null;
  onInstall: (id: string) => void;
}) {
  const busy = installing === item.id;

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between" style={ROW_DIVIDER}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-white">{item.label}</span>
          <span className={`text-xs font-medium ${statusClass(item.status)}`}>
            {statusLabel(item.status)}
          </span>
          {item.version && (
            <span className="truncate font-mono text-xs text-[#8a8a8a]">{item.version}</span>
          )}
        </div>
        {item.detail && <p className="mt-1 text-xs text-[#b5b5bd]">{item.detail}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {item.install && item.status !== 'ok' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onInstall(item.install!.id)}
            data-testid={`setup-install-${item.id}`}
          >
            {busy ? 'Installing…' : item.install.label}
          </Button>
        )}
        {item.configureUrl && (
          <Link
            to={item.configureUrl}
            className="focus-ring rounded-md border border-glass-edge px-3 py-1.5 text-xs text-[#60a5fa] hover:bg-glass-l1"
          >
            Configure
          </Link>
        )}
        {item.docsUrl && (
          <a
            href={item.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="focus-ring rounded-md px-2 py-1.5 text-xs text-[#8a8a8a] hover:text-white"
          >
            Docs
          </a>
        )}
      </div>
    </div>
  );
}

function DefaultsForm({
  initial,
  onSaved,
}: {
  initial: {
    defaultBaseBranch?: string;
    defaultJiraBaseUrl?: string;
    defaultJiraProjectKey?: string;
  };
  onSaved: () => void;
}) {
  const [baseBranch, setBaseBranch] = useState(initial.defaultBaseBranch ?? '');
  const [jiraUrl, setJiraUrl] = useState(initial.defaultJiraBaseUrl ?? '');
  const [jiraProject, setJiraProject] = useState(initial.defaultJiraProjectKey ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings({
        defaultBaseBranch: baseBranch.trim() || undefined,
        defaultJiraBaseUrl: jiraUrl.trim() || undefined,
        defaultJiraProjectKey: jiraProject.trim().toUpperCase() || undefined,
      });
      showToast('success', 'DEFAULTS', 'Task defaults saved');
      onSaved();
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 pt-2">
      <div>
        <label className="mb-1 block text-xs text-[#b5b5bd]">Default base branch</label>
        <input
          type="text"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          placeholder="main"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
          data-testid="setup-default-branch"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[#b5b5bd]">Jira base URL (optional)</label>
        <input
          type="text"
          value={jiraUrl}
          onChange={(e) => setJiraUrl(e.target.value)}
          placeholder="https://your-co.atlassian.net"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[#b5b5bd]">Default Jira project key (optional)</label>
        <input
          type="text"
          value={jiraProject}
          onChange={(e) => setJiraProject(e.target.value)}
          placeholder="PROJ"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
        />
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving} onClick={save} data-testid="setup-save-defaults">
          {saving ? 'Saving…' : 'Save defaults'}
        </Button>
      </div>
    </div>
  );
}

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof api.getSettings>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [applyingDefaults, setApplyingDefaults] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, st] = await Promise.all([api.getSettings(), api.getSetupStatus()]);
      setSettings(s);
      setStatus(st);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleInstall = async (id: string) => {
    setInstalling(id);
    try {
      const result = await api.setupInstall(id);
      showToast(result.ok ? 'success' : 'error', 'SETUP', result.message);
      await load();
    } catch (err) {
      showToast('error', 'SETUP', (err as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  const handleApplyRecommended = async () => {
    setApplyingDefaults(true);
    try {
      const next = await api.applyRecommendedDefaults();
      setSettings(next);
      showToast('success', 'DEFAULTS', 'Applied recommended defaults');
      await load();
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    } finally {
      setApplyingDefaults(false);
    }
  };

  const dismissOnboarding = async () => {
    try {
      await api.updateSettings({ onboardingCompletedAt: new Date().toISOString() });
      showToast('success', 'SETUP', 'Setup reminder dismissed');
      await load();
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    }
  };

  const itemsByCategory = (cat: (typeof CATEGORY_ORDER)[number]) =>
    status?.items.filter((i) => i.category === cat && i.id !== 'defaults') ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        variant="glass"
        title="Setup"
        description="Install dependencies, configure defaults, and connect integrations"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={applyingDefaults}
              onClick={handleApplyRecommended}
              data-testid="setup-apply-recommended"
            >
              {applyingDefaults ? 'Applying…' : 'Apply recommended defaults'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismissOnboarding}>
              Dismiss reminders
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {loading && (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse border border-glass-edge bg-glass-l1" />
              ))}
            </div>
          )}

          {error && (
            <div className="border border-red-400/30 bg-red-400/5 px-4 py-3 text-sm text-red-400">
              {error}
              <button type="button" className="ml-3 text-[#3B82F6]" onClick={load}>
                Retry
              </button>
            </div>
          )}

          {!loading && !error && status && (
            <>
              <div
                data-testid="setup-summary"
                className={
                  status.summary.ready
                    ? 'border border-[#22C55E]/30 bg-[#22C55E]/5 px-4 py-3 text-sm text-[#22C55E]'
                    : 'border border-[#FFB800]/30 bg-[#FFB800]/5 px-4 py-3 text-sm text-[#FFB800]'
                }
              >
                {status.summary.ready
                  ? 'Core dependencies are ready. Optional items can be configured below.'
                  : `${status.summary.blockerCount} required item(s) still need attention before tasks can run reliably.`}
                {status.hasBrew && status.platform === 'darwin' && (
                  <span className="mt-1 block text-xs opacity-80">
                    Homebrew installs are available from this page.
                  </span>
                )}
              </div>

              {CATEGORY_ORDER.map((cat) => {
                const items = itemsByCategory(cat);
                if (items.length === 0) return null;
                return (
                  <SectionCard key={cat} id={`setup-${cat}`} title={CATEGORY_LABELS[cat]}>
                    {items.map((item) => (
                      <SetupItemRow
                        key={item.id}
                        item={item}
                        installing={installing}
                        onInstall={handleInstall}
                      />
                    ))}
                  </SectionCard>
                );
              })}

              <SectionCard id="setup-defaults" title="Task defaults">
                <SettingRow
                  label="Defaults for new tasks"
                  description="Base branch and Jira shortcuts used by the composer and CLI"
                  lastRow
                >
                  <span />
                </SettingRow>
                {settings && (
                  <DefaultsForm
                    initial={settings}
                    onSaved={load}
                  />
                )}
              </SectionCard>

              <p className="text-center text-xs text-[#8a8a8a]">
                More options in{' '}
                <Link to="/settings" className="text-[#60a5fa] hover:underline">
                  Settings
                </Link>{' '}
                and{' '}
                <Link to="/integrations" className="text-[#60a5fa] hover:underline">
                  Integrations
                </Link>
                .
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
