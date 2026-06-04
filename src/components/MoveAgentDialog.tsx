import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { isRegularTask } from '@/lib/task-filters';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Task } from '../../server/types';

interface MoveAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  currentTaskId: string | null;
  /** Optional label for the agent in the dialog header. */
  agentLabel?: string;
  /** Called after a successful move. */
  onMoved?: (newTaskId: string | null) => void;
}

const STANDALONE_OPTION = '__standalone__';

export function MoveAgentDialog({
  open,
  onOpenChange,
  agentId,
  currentTaskId,
  agentLabel,
  onMoved,
}: MoveAgentDialogProps) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [selected, setSelected] = useState<string>(STANDALONE_OPTION);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const all = await api.listTasks();
        if (cancelled) return;
        const active = all.filter(
          (t) =>
            isRegularTask(t) &&
            (['setting_up', 'running'] as const).includes(t.runtime_state as 'running'),
        );
        setTasks(active);
        setSelected(STANDALONE_OPTION);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const eligible = useMemo(() => {
    if (!tasks) return [] as Task[];
    return tasks.filter((t) => t.id !== currentTaskId);
  }, [tasks, currentTaskId]);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    const target = selected === STANDALONE_OPTION ? null : selected;
    try {
      await api.moveAgentToTask(agentId, target);
      onMoved?.(target);
      onOpenChange(false);
      if (target === null) {
        navigate(`/chats/${agentId}`);
      } else {
        navigate(`/tasks/${target}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move {agentLabel ?? 'agent'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error && (
            <div
              data-testid="move-agent-error"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}
          <div className="flex flex-col gap-1.5 text-xs">
            <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 hover:bg-[#141414]">
              <input
                type="radio"
                name="move-agent-target"
                value={STANDALONE_OPTION}
                checked={selected === STANDALONE_OPTION}
                onChange={() => setSelected(STANDALONE_OPTION)}
              />
              <span className="font-medium">Detach — become a standalone chat</span>
            </label>
            {tasks === null ? (
              <div className="text-xs text-[#8a8a8a]">Loading tasks…</div>
            ) : eligible.length === 0 ? (
              <div className="text-xs text-[#8a8a8a]">No other active tasks available.</div>
            ) : (
              <div className="max-h-64 overflow-auto">
                {eligible.map((t) => (
                  <label
                    key={t.id}
                    data-testid={`move-agent-target-${t.id}`}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 hover:bg-[#141414]"
                  >
                    <input
                      type="radio"
                      name="move-agent-target"
                      value={t.id}
                      checked={selected === t.id}
                      onChange={() => setSelected(t.id)}
                    />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="shrink-0 text-[10px] uppercase text-[#8a8a8a]">
                      {t.runtime_state}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={submitting || (selected !== STANDALONE_OPTION && !selected)}
            >
              {submitting ? 'Moving…' : 'Move'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
