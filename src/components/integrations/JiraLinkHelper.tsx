import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { IntegrationRow } from '@/lib/api';

interface JiraLinkHelperProps {
  taskId: string;
  /** Called after successfully linking so the parent can refresh refs. */
  onLinked?: () => void;
}

/**
 * A small helper that lists enabled Jira instances and lets the user link a
 * Jira issue key to the current task. Placed next to wave-2A's free-text refs
 * panel — does NOT replace it, just adds a richer Jira-specific flow.
 */
export function JiraLinkHelper({ taskId, onLinked }: JiraLinkHelperProps) {
  const [jiraInstances, setJiraInstances] = useState<IntegrationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [issueKey, setIssueKey] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    api
      .listIntegrations()
      .then((rows) => {
        const jiras = rows.filter((r) => r.kind === 'jira' && r.enabled);
        setJiraInstances(jiras);
        if (jiras.length === 1) setSelectedId(jiras[0].id);
      })
      .catch(() => {
        // silently ignore — integrations may not be configured
      });
  }, []);

  if (jiraInstances.length === 0) return null;

  const selected = jiraInstances.find((j) => j.id === selectedId);

  async function handleLink() {
    const key = issueKey.trim().toUpperCase();
    if (!key) {
      setError('Issue key is required');
      return;
    }
    if (!selected) {
      setError('Select a Jira instance');
      return;
    }

    setError(null);
    setLinking(true);
    try {
      const baseUrl = (selected.config as Record<string, unknown>).base_url as string;
      await api.addTaskRef(taskId, {
        integration: 'jira',
        ref: key,
        url: baseUrl ? `${baseUrl.replace(/\/$/, '')}/browse/${key}` : undefined,
      });
      setIssueKey('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      onLinked?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link');
    } finally {
      setLinking(false);
    }
  }

  return (
    <div
      style={{
        background: 'rgba(59,130,246,0.06)',
        border: '1px solid rgba(59,130,246,0.2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginTop: 8,
      }}
    >
      <p
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#60a5fa',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 8,
        }}
      >
        Quick-link Jira issue
      </p>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {jiraInstances.length > 1 && (
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4,
              color: '#e2e2e7',
              fontSize: 12,
              padding: '4px 6px',
            }}
          >
            <option value="">Select instance</option>
            {jiraInstances.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        )}

        <input
          type="text"
          value={issueKey}
          onChange={(e) => setIssueKey(e.target.value)}
          placeholder="PROJ-123"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleLink();
          }}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 4,
            color: '#e2e2e7',
            fontSize: 12,
            padding: '4px 8px',
            flex: '1 1 100px',
            minWidth: 0,
          }}
        />

        <button
          type="button"
          onClick={() => void handleLink()}
          disabled={linking || !issueKey.trim()}
          style={{
            padding: '4px 10px',
            borderRadius: 4,
            border: 'none',
            background: linking ? 'rgba(59,130,246,0.5)' : '#3b82f6',
            color: 'white',
            fontSize: 12,
            cursor: linking || !issueKey.trim() ? 'not-allowed' : 'pointer',
            opacity: !issueKey.trim() ? 0.5 : 1,
          }}
        >
          {linking ? 'Linking…' : 'Link'}
        </button>
      </div>

      {error && <p style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>{error}</p>}
      {success && (
        <p style={{ fontSize: 11, color: '#4ade80', marginTop: 4 }}>Linked successfully!</p>
      )}
    </div>
  );
}
