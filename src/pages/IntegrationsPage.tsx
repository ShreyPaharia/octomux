import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/layout/section-card';
import { SettingsLayout } from '@/components/layout/settings-layout';
import { Switch } from '@/components/ui/switch';
import { InfoTooltip } from '@/components/ui/tooltip';
import { FormSelect } from '@/components/ui/form-select';
import { showToast } from '@/components/CustomToast';
import { ROW_DIVIDER } from '@/lib/design-tokens';
import { configApi } from '@/lib/api/configApi';
import type { IntegrationProvider, IntegrationRow, HookTemplate } from '@/lib/api/configApi';
import { JiraConfigForm, toJiraConfig } from '@/components/integrations/JiraConfigForm';
import type { JiraConfig } from '@/components/integrations/JiraConfigForm';
import { LinearConfigForm, toLinearConfig } from '@/components/integrations/LinearConfigForm';
import type { LinearConfig } from '@/components/integrations/LinearConfigForm';
import { useCrudSection } from '@/hooks/useCrudSection';

function providerIcon(kind: string): string {
  if (kind === 'jira') return 'J';
  if (kind === 'linear') return 'L';
  return kind.charAt(0).toUpperCase();
}

/** Display metadata for installable workflow-hook templates. */
const HOOK_TEMPLATE_META: Record<string, { label: string; tooltip: string }> = {
  'jira-status': {
    label: 'jira-status hook',
    tooltip:
      'Runs when a task’s workflow column changes and transitions the linked Jira ' +
      'issue via the status→transition-ID map in ~/.octomux/hooks. Needs JIRA_BASE_URL, ' +
      'JIRA_EMAIL and JIRA_TOKEN. This is an alternative to the Jira API integration’s ' +
      'automatic transitions — use one or the other to avoid double-firing.',
  },
};

function hookTemplateLabel(id: string): string {
  return HOOK_TEMPLATE_META[id]?.label ?? id;
}

interface IntegrationCardProps {
  integration: IntegrationRow;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  testResult: { ok: boolean; message: string } | null;
  testing: boolean;
}

function IntegrationCard({
  integration,
  onEdit,
  onDelete,
  onToggle,
  onTest,
  testResult,
  testing,
}: IntegrationCardProps) {
  return (
    <div
      className="flex items-center justify-between py-3"
      style={ROW_DIVIDER}
      data-testid={`integration-row-${integration.id}`}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/20 text-sm font-bold text-primary">
          {providerIcon(integration.kind)}
        </span>
        <div>
          <p className="text-sm font-medium text-foreground">{integration.name}</p>
          <p className="text-xs capitalize text-muted-soft">{integration.kind}</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {testResult && (
          <span
            className="text-xs"
            style={{ color: testResult.ok ? 'var(--color-success)' : 'var(--destructive)' }}
          >
            {testResult.ok ? '✓' : '✗'} {testResult.message}
          </span>
        )}
        <button
          type="button"
          className="focus-ring text-xs text-muted-soft transition-colors hover:text-foreground"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          className="focus-ring text-xs text-muted-soft transition-colors hover:text-foreground"
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="focus-ring text-xs text-destructive transition-colors hover:text-destructive/80"
          onClick={onDelete}
        >
          Delete
        </button>
        <Switch checked={integration.enabled} onChange={onToggle} />
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-glass-edge bg-popover p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-soft hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  const [providers, setProviders] = useState<IntegrationProvider[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    | { kind: 'create-jira' }
    | { kind: 'edit-jira'; integration: IntegrationRow }
    | { kind: 'create-linear' }
    | { kind: 'edit-linear'; integration: IntegrationRow }
    | null
  >(null);
  const deleteCrud = useCrudSection({
    onDelete: async (id) => {
      await configApi.deleteIntegration(id);
      void refresh();
    },
  });
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  );
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [hookTemplates, setHookTemplates] = useState<HookTemplate[]>([]);
  const [installingHook, setInstallingHook] = useState<string | null>(null);
  const [tracker, setTracker] = useState<'jira' | 'linear' | ''>('');
  const [savingTracker, setSavingTracker] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, i, hooks, settings] = await Promise.all([
        configApi.listProviders(),
        configApi.listIntegrations(),
        configApi.listHookTemplates().catch(() => [] as HookTemplate[]),
        configApi.getSettings().catch(() => null),
      ]);
      setProviders(p);
      setIntegrations(i);
      setHookTemplates(hooks);
      if (settings) setTracker(settings.defaultTracker ?? '');
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleInstallHook(id: string) {
    setInstallingHook(id);
    try {
      await configApi.installHookTemplate(id);
      showToast('success', 'HOOKS', `Installed ${hookTemplateLabel(id)}`);
      void refresh();
    } catch (err) {
      showToast('error', 'HOOKS', err instanceof Error ? err.message : 'Install failed');
    } finally {
      setInstallingHook(null);
    }
  }

  async function handleTrackerChange(next: 'jira' | 'linear' | '') {
    setTracker(next);
    setSavingTracker(true);
    try {
      await configApi.updateSettings({ defaultTracker: next || undefined });
      showToast('success', 'INTEGRATIONS', 'Primary tracker saved');
    } catch (err) {
      showToast('error', 'INTEGRATIONS', err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingTracker(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreateJira(config: JiraConfig, name: string) {
    await configApi.createIntegration('jira', name, config as unknown as Record<string, unknown>);
    setModal(null);
    void refresh();
  }

  async function handleEditJira(id: string, config: JiraConfig, name: string) {
    await configApi.updateIntegration(id, {
      name,
      config: config as unknown as Record<string, unknown>,
    });
    setModal(null);
    void refresh();
  }

  async function handleCreateLinear(config: LinearConfig, name: string) {
    await configApi.createIntegration('linear', name, config as unknown as Record<string, unknown>);
    setModal(null);
    void refresh();
  }

  async function handleEditLinear(id: string, config: LinearConfig, name: string) {
    await configApi.updateIntegration(id, {
      name,
      config: config as unknown as Record<string, unknown>,
    });
    setModal(null);
    void refresh();
  }

  async function handleDelete() {
    await deleteCrud.delete.submit();
  }

  async function handleToggle(id: string, enabled: boolean) {
    await configApi.updateIntegration(id, { enabled });
    void refresh();
  }

  async function handleTest(id: string) {
    setTesting((t) => ({ ...t, [id]: true }));
    try {
      const result = await configApi.testIntegration(id);
      setTestResults((r) => ({ ...r, [id]: result }));
    } catch (err) {
      setTestResults((r) => ({
        ...r,
        [id]: { ok: false, message: err instanceof Error ? err.message : 'Test failed' },
      }));
    } finally {
      setTesting((t) => ({ ...t, [id]: false }));
    }
  }

  if (loading) {
    return (
      <SettingsLayout title="Integrations" description="Connect Octomux to external systems">
        <p className="text-sm text-muted-soft">Loading integrations…</p>
      </SettingsLayout>
    );
  }

  return (
    <>
      <SettingsLayout
        title="Integrations"
        description="Workflow column changes fire to enabled integrations"
      >
        <SectionCard id="providers" title="Available providers">
          {providers.length === 0 ? (
            <p className="py-2 text-xs text-muted-soft">No providers registered.</p>
          ) : (
            providers.map((p) => (
              <div
                key={p.kind}
                className="flex items-center justify-between py-3"
                style={ROW_DIVIDER}
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-primary/20 text-sm font-bold text-primary">
                    {providerIcon(p.kind)}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">{p.displayName}</p>
                    <p className="text-xs text-muted-soft">Events: {p.events.join(', ')}</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    if (p.kind === 'jira') setModal({ kind: 'create-jira' });
                    else if (p.kind === 'linear') setModal({ kind: 'create-linear' });
                  }}
                >
                  Add {p.displayName}
                </Button>
              </div>
            ))
          )}
        </SectionCard>

        <SectionCard id="configured" title="Configured" count={integrations.length}>
          {integrations.length === 0 ? (
            <p className="py-2 text-xs text-muted-soft">
              No integrations configured. Add one above.
            </p>
          ) : (
            integrations.map((i) => (
              <IntegrationCard
                key={i.id}
                integration={i}
                onEdit={() => {
                  if (i.kind === 'jira') setModal({ kind: 'edit-jira', integration: i });
                  else if (i.kind === 'linear') setModal({ kind: 'edit-linear', integration: i });
                }}
                onDelete={() => deleteCrud.delete.setTarget(i.id)}
                onToggle={(enabled) => void handleToggle(i.id, enabled)}
                onTest={() => void handleTest(i.id)}
                testResult={testResults[i.id] ?? null}
                testing={testing[i.id] ?? false}
              />
            ))
          )}
        </SectionCard>

        <SectionCard id="primary-tracker" title="Primary tracker">
          <div
            className="flex items-center justify-between py-3"
            style={ROW_DIVIDER}
            data-testid="primary-tracker-row"
          >
            <div>
              <p className="text-sm font-medium text-foreground">Default tracker for new tasks</p>
              <p className="text-xs text-muted-soft">
                Used by the create-task flow when more than one tracker is configured.
              </p>
            </div>
            <FormSelect
              value={tracker}
              disabled={savingTracker}
              fieldSize="md"
              onChange={(e) => void handleTrackerChange(e.target.value as 'jira' | 'linear' | '')}
              data-testid="primary-tracker-select"
              aria-label="Primary tracker"
            >
              <option value="">— none —</option>
              <option value="linear">Linear</option>
              <option value="jira">Jira</option>
            </FormSelect>
          </div>
        </SectionCard>

        <SectionCard id="workflow-hooks" title="Workflow hooks">
          {hookTemplates.length === 0 ? (
            <p className="py-2 text-xs text-muted-soft">No hook templates available.</p>
          ) : (
            hookTemplates.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between py-3"
                style={ROW_DIVIDER}
                data-testid={`hook-template-${h.id}`}
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{hookTemplateLabel(h.id)}</p>
                  {HOOK_TEMPLATE_META[h.id]?.tooltip && (
                    <InfoTooltip
                      content={HOOK_TEMPLATE_META[h.id].tooltip}
                      label={`About ${hookTemplateLabel(h.id)}`}
                    />
                  )}
                </div>
                {h.installed ? (
                  <span className="text-xs font-medium text-[#22C55E]">Installed</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={installingHook === h.id}
                    onClick={() => void handleInstallHook(h.id)}
                    data-testid={`hook-install-${h.id}`}
                  >
                    {installingHook === h.id ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </div>
            ))
          )}
        </SectionCard>
      </SettingsLayout>

      {modal?.kind === 'create-jira' && (
        <Modal title="Add Jira integration" onClose={() => setModal(null)}>
          <JiraConfigForm
            onSubmit={handleCreateJira}
            onCancel={() => setModal(null)}
            submitLabel="Create"
          />
        </Modal>
      )}

      {modal?.kind === 'edit-jira' && (
        <Modal title="Edit Jira integration" onClose={() => setModal(null)}>
          <JiraConfigForm
            initial={toJiraConfig(modal.integration)}
            nameInitial={modal.integration.name}
            onSubmit={(config, name) => handleEditJira(modal.integration.id, config, name)}
            onCancel={() => setModal(null)}
            submitLabel="Save changes"
          />
        </Modal>
      )}

      {modal?.kind === 'create-linear' && (
        <Modal title="Add Linear integration" onClose={() => setModal(null)}>
          <LinearConfigForm
            onSubmit={handleCreateLinear}
            onCancel={() => setModal(null)}
            submitLabel="Create"
          />
        </Modal>
      )}

      {modal?.kind === 'edit-linear' && (
        <Modal title="Edit Linear integration" onClose={() => setModal(null)}>
          <LinearConfigForm
            initial={toLinearConfig(modal.integration)}
            nameInitial={modal.integration.name}
            onSubmit={(config, name) => handleEditLinear(modal.integration.id, config, name)}
            onCancel={() => setModal(null)}
            submitLabel="Save changes"
          />
        </Modal>
      )}

      {deleteCrud.delete.open && (
        <Modal title="Delete integration" onClose={() => deleteCrud.delete.onOpenChange(false)}>
          <p className="mb-4 text-sm text-muted-foreground">
            Are you sure you want to delete this integration? This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => deleteCrud.delete.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteCrud.delete.deleting}
              onClick={() => void handleDelete()}
            >
              {deleteCrud.delete.deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
