import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/layout/section-card';
import { SettingsLayout } from '@/components/layout/settings-layout';
import { Switch } from '@/components/ui/switch';
import { ROW_DIVIDER } from '@/lib/design-tokens';
import { api } from '@/lib/api';
import type { IntegrationProvider, IntegrationRow } from '@/lib/api';
import { JiraConfigForm, toJiraConfig } from '@/components/integrations/JiraConfigForm';
import type { JiraConfig } from '@/components/integrations/JiraConfigForm';
import { LinearConfigForm, toLinearConfig } from '@/components/integrations/LinearConfigForm';
import type { LinearConfig } from '@/components/integrations/LinearConfigForm';

function providerIcon(kind: string): string {
  if (kind === 'jira') return 'J';
  if (kind === 'linear') return 'L';
  return kind.charAt(0).toUpperCase();
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
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  );
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const [p, i] = await Promise.all([api.listProviders(), api.listIntegrations()]);
      setProviders(p);
      setIntegrations(i);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreateJira(config: JiraConfig, name: string) {
    await api.createIntegration('jira', name, config as unknown as Record<string, unknown>);
    setModal(null);
    void refresh();
  }

  async function handleEditJira(id: string, config: JiraConfig, name: string) {
    await api.updateIntegration(id, {
      name,
      config: config as unknown as Record<string, unknown>,
    });
    setModal(null);
    void refresh();
  }

  async function handleCreateLinear(config: LinearConfig, name: string) {
    await api.createIntegration('linear', name, config as unknown as Record<string, unknown>);
    setModal(null);
    void refresh();
  }

  async function handleEditLinear(id: string, config: LinearConfig, name: string) {
    await api.updateIntegration(id, {
      name,
      config: config as unknown as Record<string, unknown>,
    });
    setModal(null);
    void refresh();
  }

  async function handleDelete(id: string) {
    await api.deleteIntegration(id);
    setDeleteConfirmId(null);
    void refresh();
  }

  async function handleToggle(id: string, enabled: boolean) {
    await api.updateIntegration(id, { enabled });
    void refresh();
  }

  async function handleTest(id: string) {
    setTesting((t) => ({ ...t, [id]: true }));
    try {
      const result = await api.testIntegration(id);
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
                onDelete={() => setDeleteConfirmId(i.id)}
                onToggle={(enabled) => void handleToggle(i.id, enabled)}
                onTest={() => void handleTest(i.id)}
                testResult={testResults[i.id] ?? null}
                testing={testing[i.id] ?? false}
              />
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

      {deleteConfirmId && (
        <Modal title="Delete integration" onClose={() => setDeleteConfirmId(null)}>
          <p className="mb-4 text-sm text-muted-foreground">
            Are you sure you want to delete this integration? This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete(deleteConfirmId)}
            >
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
