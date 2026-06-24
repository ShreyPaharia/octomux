import { useState } from 'react';
import type { IntegrationRow } from '@/lib/api/configApi';

export interface JiraConfig {
  base_url: string;
  email: string;
  api_token: string;
  default_project?: string;
  status_map: {
    backlog?: string;
    planned?: string;
    in_progress?: string;
    human_review?: string;
    pr?: string;
    done?: string;
  };
}

const WORKFLOW_STATUSES = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'planned', label: 'Planned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'human_review', label: 'Human Review' },
  { key: 'pr', label: 'PR' },
  { key: 'done', label: 'Done' },
] as const;

const FIELD_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#e2e2e7',
  fontSize: 13,
  padding: '6px 10px',
  width: '100%',
  outline: 'none',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 600,
  color: '#8a8a8a',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 4,
};

interface JiraConfigFormProps {
  initial?: Partial<JiraConfig>;
  onSubmit: (config: JiraConfig, name: string) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
  nameInitial?: string;
}

export function JiraConfigForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
  nameInitial = '',
}: JiraConfigFormProps) {
  const [name, setName] = useState(nameInitial);
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [apiToken, setApiToken] = useState(initial?.api_token ?? '');
  const [defaultProject, setDefaultProject] = useState(initial?.default_project ?? '');
  const [statusMap, setStatusMap] = useState<Record<string, string>>(initial?.status_map ?? {});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!baseUrl.trim()) {
      setError('Base URL is required');
      return;
    }
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!apiToken.trim()) {
      setError('API token is required');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(
        {
          base_url: baseUrl.trim(),
          email: email.trim(),
          api_token: apiToken,
          default_project: defaultProject.trim() || undefined,
          status_map: statusMap,
        },
        name.trim(),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={LABEL_STYLE}>Instance name</label>
        <input
          style={FIELD_STYLE}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Jira"
          required
        />
      </div>

      <div>
        <label style={LABEL_STYLE}>Base URL</label>
        <input
          style={FIELD_STYLE}
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://acme.atlassian.net"
          required
        />
      </div>

      <div>
        <label style={LABEL_STYLE}>Email</label>
        <input
          style={FIELD_STYLE}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
        />
      </div>

      <div>
        <label style={LABEL_STYLE}>API Token</label>
        <input
          style={FIELD_STYLE}
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={
            apiToken === '••••' ? 'Leave as-is to keep stored token' : 'Atlassian API token'
          }
          autoComplete="off"
        />
        <p style={{ fontSize: 11, color: '#8a8a8a', marginTop: 4 }}>
          Generate at Atlassian account settings → Security → API tokens. Use{' '}
          <code style={{ fontFamily: 'monospace' }}>${'{env:MY_VAR}'}</code> to read from an
          environment variable.
        </p>
      </div>

      <div>
        <label style={LABEL_STYLE}>Default project key (optional)</label>
        <input
          style={FIELD_STYLE}
          value={defaultProject}
          onChange={(e) => setDefaultProject(e.target.value)}
          placeholder="e.g. PROJ"
        />
      </div>

      <div>
        <label style={{ ...LABEL_STYLE, marginBottom: 8 }}>Workflow → Jira transition ID map</label>
        <p style={{ fontSize: 11, color: '#8a8a8a', marginBottom: 8 }}>
          Map each octomux workflow status to a Jira transition ID (numeric). Leave blank to skip.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {WORKFLOW_STATUSES.map(({ key, label }) => (
            <div key={key}>
              <label style={{ ...LABEL_STYLE, marginBottom: 2 }}>{label}</label>
              <input
                style={FIELD_STYLE}
                value={statusMap[key] ?? ''}
                onChange={(e) =>
                  setStatusMap((m) => {
                    const next = { ...m };
                    if (e.target.value) {
                      next[key] = e.target.value;
                    } else {
                      delete next[key];
                    }
                    return next;
                  })
                }
                placeholder="Transition ID"
              />
            </div>
          ))}
        </div>
      </div>

      {error && <p style={{ fontSize: 12, color: '#f87171', margin: 0 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'transparent',
            color: '#b5b5bd',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: submitting ? 'rgba(59,130,246,0.5)' : '#3b82f6',
            color: 'white',
            fontSize: 13,
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Extract typed JiraConfig from a generic IntegrationRow.config */
export function toJiraConfig(row: IntegrationRow): JiraConfig {
  const cfg = row.config as Record<string, unknown>;
  return {
    base_url: String(cfg.base_url ?? ''),
    email: String(cfg.email ?? ''),
    api_token: String(cfg.api_token ?? ''),
    default_project: cfg.default_project ? String(cfg.default_project) : undefined,
    status_map: (cfg.status_map ?? {}) as Record<string, string>,
  };
}
