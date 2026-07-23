import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  agentsApi,
  type AgentStatus,
  type AgentWithStatus,
  type CreateAgentInput,
} from '@/lib/api/agentsApi';
import { useResource } from '@/lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormSelect } from '@/components/ui/form-select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/layout/page-header';
import { PlusIcon } from '@/components/icons';
import { timeAgo } from '@/lib/time';

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

function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <Badge variant="outline" className={STATUS_STYLE[status]} data-testid="agent-status-pill">
      {status}
    </Badge>
  );
}

interface NewAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: AgentWithStatus) => void;
}

function NewAgentDialog({ open, onOpenChange, onCreated }: NewAgentDialogProps) {
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [channel, setChannel] = useState('');
  const [threadKey, setThreadKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName('');
    setSystemPrompt('');
    setChannel('');
    setThreadKey('');
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return;
      if (!next) reset();
      onOpenChange(next);
    },
    [submitting, reset, onOpenChange],
  );

  const canSubmit = !submitting && name.trim().length > 0 && systemPrompt.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const input: CreateAgentInput = {
        name: name.trim(),
        system_prompt: systemPrompt.trim(),
        channel: channel || null,
        channel_config: threadKey.trim() ? JSON.stringify({ threadKey: threadKey.trim() }) : null,
      };
      const agent = await agentsApi.create(input);
      reset();
      onOpenChange(false);
      onCreated(agent);
    } catch (err) {
      setError((err as Error).message || 'Failed to create agent');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, name, systemPrompt, channel, threadKey, reset, onOpenChange, onCreated]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="new-agent-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Create a long-running agent with its own system prompt and, optionally, a channel it
            listens on.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              data-testid="agent-name"
              placeholder="e.g. support-bot"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-system-prompt">System prompt</Label>
            <Textarea
              id="agent-system-prompt"
              data-testid="agent-system-prompt"
              rows={5}
              placeholder="What should this agent do?"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>

          <div className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="agent-channel">Channel</Label>
              <FormSelect
                id="agent-channel"
                data-testid="agent-channel"
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
              <Label htmlFor="agent-thread-key">Thread key (optional)</Label>
              <Input
                id="agent-thread-key"
                data-testid="agent-thread-key"
                placeholder="none — binds whole channel"
                value={threadKey}
                onChange={(e) => setThreadKey(e.target.value)}
                disabled={!channel}
              />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button data-testid="new-agent-submit" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Creating…' : 'Create agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentsPage() {
  const { data, loading, error, refresh } = useResource<AgentWithStatus[]>('agents', () =>
    agentsApi.list(),
  );
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const agents = data ?? [];
  const nav = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader
        title="Agents"
        description="Long-running agents with their own system prompt and channel binding."
        actions={
          <Button size="sm" onClick={() => setNewAgentOpen(true)} data-testid="new-agent-button">
            <PlusIcon data-icon="inline-start" />
            New agent
          </Button>
        }
      />

      {loading ? (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-2xl border border-glass-edge bg-glass-l1"
            />
          ))}
        </div>
      ) : error ? (
        <p className="mt-4 text-sm text-destructive">Failed to load agents: {error}</p>
      ) : agents.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No agents yet.</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <GlassPanel
              key={agent.id}
              level={2}
              specular
              data-testid={`agent-card-${agent.id}`}
              className="group flex cursor-pointer flex-col gap-3 rounded-2xl p-4 transition-colors hover:bg-glass-l3/80"
              onClick={() => nav(`/agents/${agent.id}`)}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 truncate text-sm font-medium text-foreground group-hover:text-primary">
                  {agent.name}
                </h3>
                <StatusPill status={agent.status} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" data-testid={`agent-channel-${agent.id}`}>
                  {agent.channel ?? 'no channel'}
                </Badge>
              </div>
              <p className="mt-auto text-[10px] text-muted-soft">
                Updated {timeAgo(agent.updated_at)}
              </p>
            </GlassPanel>
          ))}
        </div>
      )}

      <NewAgentDialog
        open={newAgentOpen}
        onOpenChange={setNewAgentOpen}
        onCreated={() => {
          refresh();
        }}
      />
    </div>
  );
}
