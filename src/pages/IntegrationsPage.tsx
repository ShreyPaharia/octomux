import { useState, useEffect, useCallback } from 'react';
import { GlassPanel } from '@/components/ui/glass-panel';
import { api } from '@/lib/api';
import type { IntegrationProvider, IntegrationRow } from '@/lib/api';
import { JiraConfigForm, toJiraConfig } from '@/components/integrations/JiraConfigForm';
import type { JiraConfig } from '@/components/integrations/JiraConfigForm';

// ─── Styles ────────────────────────────────────────────────────────────────────

const ROW_DIVIDER: React.CSSProperties = { borderBottom: '1px solid rgba(255,255,255,0.10)' };

const TOGGLE_ON: React.CSSProperties = {
  background: 'linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%)',
  boxShadow: '0 0 12px rgba(59,130,246,0.45), inset 0 1px 0 rgba(255,255,255,0.35)',
};

const TOGGLE_OFF: React.CSSProperties = {
  backgroundColor: 'rgba(255,255,255,0.08)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)',
  border: '1px solid rgba(255,255,255,0.14)',
};

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="focus-ring relative h-5 w-9 transition-colors"
      style={checked ? TOGGLE_ON : TOGGLE_OFF}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  );
}

// ─── Provider kind → display helpers ─────────────────────────────────────────

function providerIcon(kind: string): string {
  if (kind === 'jira') return 'J';
  return kind.charAt(0).toUpperCase();
}

// ─── Integration row card ─────────────────────────────────────────────────────

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
        <span
          className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-bold"
          style={{ background: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}
        >
          {providerIcon(integration.kind)}
        </span>
        <div>
          <p className="text-sm font-medium text-white">{integration.name}</p>
          <p className="text-xs text-[#8a8a8a] capitalize">{integration.kind}</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {testResult && (
          <span
            className="text-xs"
            style={{ color: testResult.ok ? '#4ade80' : '#f87171' }}
          >
            {testResult.ok ? '✓' : '✗'} {testResult.message}
          </span>
        )}
        <button
          type="button"
          className="focus-ring text-xs text-[#8a8a8a] transition-colors hover:text-white"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          className="focus-ring text-xs text-[#8a8a8a] transition-colors hover:text-white"
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="focus-ring text-xs text-red-400 transition-colors hover:text-red-300"
          onClick={onDelete}
        >
          Delete
        </button>
        <ToggleSwitch checked={integration.enabled} onChange={onToggle} />
      </div>
    </div>
  );
}

// ─── Modal wrapper ────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl"
        style={{ background: '#16161e', border: '1px solid rgba(255,255,255,0.12)', padding: 24 }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[#8a8a8a] hover:text-white"
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const [providers, setProviders] = useState<IntegrationProvider[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    | { kind: 'create-jira' }
    | { kind: 'edit-jira'; integration: IntegrationRow }
    | null
  >(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
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
      <div className="flex h-full items-center justify-center text-[#8a8a8a] text-sm">
        Loading integrations…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <GlassPanel level={1}>
        <div className="px-6 py-4">
          <h1 className="font-display text-[30px] font-semibold leading-none text-white">
            Integrations
          </h1>
          <p className="mt-1 font-mono text-[11px] text-[#8a8a8a]">
            // connect octomux to external systems · workflow column changes fire to enabled integrations
          </p>
        </div>
      </GlassPanel>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-6">

          {/* ─── Available providers ─── */}
          <section>
            <GlassPanel level={2} className="px-5">
              <header className="flex items-center justify-between" style={{ ...ROW_DIVIDER, padding: '18px 0' }}>
                <h2 className="text-[11px] font-bold uppercase tracking-wider text-white">
                  Available providers
                </h2>
              </header>
              <div className="py-2">
                {providers.length === 0 ? (
                  <p className="py-2 text-xs text-[#8a8a8a]">No providers registered.</p>
                ) : (
                  providers.map((p) => (
                    <div
                      key={p.kind}
                      className="flex items-center justify-between py-3"
                      style={ROW_DIVIDER}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-bold"
                          style={{ background: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}
                        >
                          {providerIcon(p.kind)}
                        </span>
                        <div>
                          <p className="text-sm font-medium text-white">{p.displayName}</p>
                          <p className="text-xs text-[#8a8a8a]">
                            Events: {p.events.join(', ')}
                          </p>
                        </div>
                      </div>
                      {p.kind === 'jira' && (
                        <button
                          type="button"
                          onClick={() => setModal({ kind: 'create-jira' })}
                          className="focus-ring rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors"
                          style={{ background: '#3b82f6' }}
                        >
                          Add Jira
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </GlassPanel>
          </section>

          {/* ─── Configured integrations ─── */}
          <section>
            <GlassPanel level={2} className="px-5">
              <header className="flex items-center justify-between" style={{ ...ROW_DIVIDER, padding: '18px 0' }}>
                <div className="flex items-center gap-3">
                  <h2 className="text-[11px] font-bold uppercase tracking-wider text-white">
                    Configured
                  </h2>
                  <span className="text-xs text-[#8a8a8a]">{integrations.length}</span>
                </div>
              </header>
              <div className="py-2">
                {integrations.length === 0 ? (
                  <p className="py-2 text-xs text-[#8a8a8a]">
                    No integrations configured. Add one above.
                  </p>
                ) : (
                  integrations.map((i) => (
                    <IntegrationCard
                      key={i.id}
                      integration={i}
                      onEdit={() => {
                        if (i.kind === 'jira') setModal({ kind: 'edit-jira', integration: i });
                      }}
                      onDelete={() => setDeleteConfirmId(i.id)}
                      onToggle={(enabled) => void handleToggle(i.id, enabled)}
                      onTest={() => void handleTest(i.id)}
                      testResult={testResults[i.id] ?? null}
                      testing={testing[i.id] ?? false}
                    />
                  ))
                )}
              </div>
            </GlassPanel>
          </section>
        </div>
      </div>

      {/* ─── Create Jira modal ─── */}
      {modal?.kind === 'create-jira' && (
        <Modal title="Add Jira integration" onClose={() => setModal(null)}>
          <JiraConfigForm
            onSubmit={handleCreateJira}
            onCancel={() => setModal(null)}
            submitLabel="Create"
          />
        </Modal>
      )}

      {/* ─── Edit Jira modal ─── */}
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

      {/* ─── Delete confirm modal ─── */}
      {deleteConfirmId && (
        <Modal title="Delete integration" onClose={() => setDeleteConfirmId(null)}>
          <p className="mb-4 text-sm text-[#e2e2e7]">
            Are you sure you want to delete this integration? This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteConfirmId(null)}
              className="focus-ring rounded-md px-3 py-1.5 text-xs text-[#b5b5bd] hover:text-white"
              style={{ border: '1px solid rgba(255,255,255,0.15)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDelete(deleteConfirmId)}
              className="focus-ring rounded-md px-3 py-1.5 text-xs text-white"
              style={{ background: '#ef4444' }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
