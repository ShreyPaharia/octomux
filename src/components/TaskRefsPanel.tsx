import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TaskExternalRef } from '../../server/types';

interface TaskRefsPanelProps {
  taskId: string;
  /** Initial refs from the task object, to avoid extra fetch on first render. */
  initialRefs?: TaskExternalRef[];
}

export function TaskRefsPanel({ taskId, initialRefs }: TaskRefsPanelProps) {
  const [refs, setRefs] = useState<TaskExternalRef[]>(initialRefs ?? []);
  const [integration, setIntegration] = useState('');
  const [ref, setRef] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getTaskRefs(taskId);
      setRefs(data);
    } catch {
      // swallow
    }
  }, [taskId]);

  useEffect(() => {
    if (!initialRefs) {
      load();
    }
  }, [initialRefs, load]);

  const handleAdd = useCallback(async () => {
    const trimmedIntegration = integration.trim();
    const trimmedRef = ref.trim();
    if (!trimmedIntegration || !trimmedRef) return;
    setError(null);
    setAdding(true);
    try {
      const newRef = await api.addTaskRef(taskId, {
        integration: trimmedIntegration,
        ref: trimmedRef,
        url: url.trim() || undefined,
      });
      setRefs((prev) => [...prev, newRef]);
      setIntegration('');
      setRef('');
      setUrl('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }, [taskId, integration, ref, url]);

  const handleRemove = useCallback(
    async (integrationKey: string) => {
      try {
        await api.deleteTaskRef(taskId, integrationKey);
        setRefs((prev) => prev.filter((r) => r.integration !== integrationKey));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [taskId],
  );

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        Linked Refs
      </h2>

      {/* Existing refs list */}
      {refs.length === 0 ? (
        <p className="text-[11px] text-muted-soft">No integrations linked.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {refs.map((r) => (
            <div
              key={r.integration}
              className="flex items-center gap-2 rounded-lg border border-glass-edge bg-glass-l1 px-3 py-2"
            >
              <span
                className={`text-[11px] font-medium ${r.integration === 'linear' ? 'text-[#a78bfa]' : 'text-muted-foreground'}`}
              >
                {r.integration}
              </span>
              <span className="text-[10px] text-muted-soft">:</span>
              {r.url ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-primary hover:underline"
                >
                  {r.ref}
                </a>
              ) : (
                <span className="text-[11px] text-foreground">{r.ref}</span>
              )}
              {typeof r.metadata?.team_key === 'string' && (
                <span className="rounded bg-glass-l2 px-1.5 py-0.5 text-[10px] font-medium text-[#b5b5bd]">
                  {r.metadata.team_key}
                </span>
              )}
              <button
                type="button"
                className="ml-auto text-[10px] text-muted-soft hover:text-destructive"
                onClick={() => handleRemove(r.integration)}
                aria-label={`Remove ${r.integration} ref`}
                data-testid={`remove-ref-${r.integration}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add ref form */}
      <div className="flex flex-col gap-2 rounded-xl border border-glass-edge bg-glass-l1/50 p-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-soft">Add ref</p>
        <div className="flex gap-2">
          <Input
            placeholder="jira"
            value={integration}
            onChange={(e) => setIntegration(e.target.value)}
            className="h-7 text-xs"
            data-testid="ref-integration-input"
          />
          <Input
            placeholder="PROJECT-123"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            className="h-7 text-xs"
            data-testid="ref-value-input"
          />
        </div>
        <Input
          placeholder="URL (optional)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="h-7 text-xs"
          data-testid="ref-url-input"
        />
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        <Button
          size="sm"
          disabled={adding || !integration.trim() || !ref.trim()}
          onClick={handleAdd}
          data-testid="add-ref-button"
          className="h-7 self-end text-xs"
        >
          {adding ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
