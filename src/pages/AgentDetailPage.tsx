/**
 * src/pages/AgentDetailPage.tsx
 *
 * Route: /agents/:id
 *
 * Two tabs for a single long-running agent:
 *  - Config   — edit name/system prompt/channel binding, save, delete.
 *  - Sessions — ensure + render the agent's persistent conductor session
 *               via <AgentSessionChat>.
 *
 * Standalone page — does not import from OrchestratorPage.tsx (kept untouched).
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { agentsApi, type AgentStatus, type AgentWithStatus } from '@/lib/api/agentsApi';
import { useResource } from '@/lib/use-resource';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormSelect } from '@/components/ui/form-select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { PageHeader } from '@/components/layout/page-header';
import { ChevronLeftIcon } from '@/components/icons';
import { AgentSessionChat } from '@/components/AgentSessionChat';

const STATUS_STYLE: Record<AgentStatus, string> = {
  working: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  idle: 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400',
  stopped: 'border-border bg-transparent text-muted-foreground',
};

const CHANNEL_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'slack', label: 'Slack' },
];

function parseThreadKey(channelConfig: string | null): string {
  if (!channelConfig) return '';
  try {
    const parsed = JSON.parse(channelConfig) as { threadKey?: string };
    return parsed.threadKey ?? '';
  } catch {
    return '';
  }
}

interface ConfigTabProps {
  agent: AgentWithStatus;
  onSaved: (agent: AgentWithStatus) => void;
  onDeleted: () => void;
}

function ConfigTab({ agent, onSaved, onDeleted }: ConfigTabProps) {
  const [name, setName] = useState(agent.name);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [channel, setChannel] = useState(agent.channel ?? '');
  const [threadKey, setThreadKey] = useState(parseThreadKey(agent.channel_config));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(agent.name);
    setSystemPrompt(agent.system_prompt);
    setChannel(agent.channel ?? '');
    setThreadKey(parseThreadKey(agent.channel_config));
  }, [agent]);

  const canSave = name.trim().length > 0 && systemPrompt.trim().length > 0 && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await agentsApi.update(agent.id, {
        name: name.trim(),
        system_prompt: systemPrompt.trim(),
        channel: channel || null,
        channel_config: threadKey.trim() ? JSON.stringify({ threadKey: threadKey.trim() }) : null,
      });
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message || 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }, [canSave, agent.id, name, systemPrompt, channel, threadKey, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`Delete agent "${agent.name}"? This stops its session too.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await agentsApi.remove(agent.id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message || 'Failed to delete agent');
      setDeleting(false);
    }
  }, [agent.id, agent.name, onDeleted]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-detail-name">Name</Label>
        <Input
          id="agent-detail-name"
          data-testid="agent-detail-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-detail-system-prompt">System prompt</Label>
        <Textarea
          id="agent-detail-system-prompt"
          data-testid="agent-detail-system-prompt"
          rows={8}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </div>

      <div className="flex items-end gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="agent-detail-channel">Channel</Label>
          <FormSelect
            id="agent-detail-channel"
            data-testid="agent-detail-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            {CHANNEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </FormSelect>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="agent-detail-thread-key">Thread key (optional)</Label>
          <Input
            id="agent-detail-thread-key"
            data-testid="agent-detail-thread-key"
            placeholder="none — binds whole channel"
            value={threadKey}
            onChange={(e) => setThreadKey(e.target.value)}
            disabled={!channel}
          />
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-between pt-2">
        <Button
          variant="outline"
          onClick={handleDelete}
          disabled={deleting}
          data-testid="agent-detail-delete"
        >
          {deleting ? 'Deleting…' : 'Delete agent'}
        </Button>
        <Button onClick={handleSave} disabled={!canSave} data-testid="agent-detail-save">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function SessionsTab({ agentId }: { agentId: string }) {
  const [convId, setConvId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    agentsApi
      .ensureSession(agentId)
      .then((session) => {
        if (!cancelled) setConvId(session.id);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message || 'Failed to start session');
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (error) {
    return <p className="p-6 text-sm text-destructive">Failed to load session: {error}</p>;
  }

  if (!convId) {
    return <p className="p-6 text-sm text-muted-foreground">Starting session…</p>;
  }

  return <AgentSessionChat convId={convId} />;
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'config' | 'sessions'>('config');

  const {
    data: agent,
    loading,
    error,
    refresh,
  } = useResource<AgentWithStatus>(id ?? null, () => agentsApi.get(id!));

  if (loading || !agent) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {error ? `Failed to load agent: ${error}` : 'Loading…'}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-6 pb-0">
        <button
          onClick={() => navigate('/agents')}
          className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="agent-detail-back"
        >
          <ChevronLeftIcon />
          All agents
        </button>

        <PageHeader
          title={agent.name}
          eyebrowContent={
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={STATUS_STYLE[agent.status]}>
                {agent.status}
              </Badge>
              {agent.session_id && (
                <span className="font-mono text-[11px] text-muted-soft">
                  session {agent.session_id}
                </span>
              )}
            </div>
          }
        />

        <SegmentedControl
          className="mt-4"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'config', label: 'Config', testId: 'agent-tab-config' },
            { value: 'sessions', label: 'Sessions', testId: 'agent-tab-sessions' },
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'config' ? (
          <div className="overflow-auto">
            <ConfigTab
              agent={agent}
              onSaved={() => refresh()}
              onDeleted={() => navigate('/agents')}
            />
          </div>
        ) : (
          <SessionsTab agentId={agent.id} />
        )}
      </div>
    </div>
  );
}
