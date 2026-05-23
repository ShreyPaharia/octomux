import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/event-source';
import { timeAgo } from '@/lib/time';
import type { TaskUpdate } from '../../server/types';

const KIND_ICON: Record<TaskUpdate['kind'], string> = {
  transition: '→',
  summary: '📝',
  note: '💬',
};

const KIND_LABEL: Record<TaskUpdate['kind'], string> = {
  transition: 'Moved',
  summary: 'Summary',
  note: 'Note',
};

interface TaskActivityPanelProps {
  taskId: string;
}

export function TaskActivityPanel({ taskId }: TaskActivityPanelProps) {
  const [updates, setUpdates] = useState<TaskUpdate[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.getTaskUpdates(taskId, 50);
      setUpdates(data);
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
    return subscribe((event) => {
      const affectedId = event.payload.taskId ?? (event.payload as { taskId?: string }).taskId;
      if (affectedId === taskId) {
        load();
      }
    });
  }, [load, taskId]);

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        Activity
      </h2>
      {loading ? (
        <div className="text-[11px] text-muted-soft">Loading…</div>
      ) : updates.length === 0 ? (
        <div className="text-[11px] text-muted-soft">No activity yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {updates.map((u) => (
            <ActivityRow key={u.id} update={u} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ update }: { update: TaskUpdate }) {
  const icon = KIND_ICON[update.kind];
  const label = KIND_LABEL[update.kind];
  const author = update.agent_id ? `agent: ${update.agent_id}` : 'human';

  return (
    <div className="flex items-start gap-2 rounded-lg border border-glass-edge bg-glass-l1 px-3 py-2">
      <span className="mt-0.5 shrink-0 text-[12px]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
          {update.kind === 'transition' && update.from_status && update.to_status && (
            <span className="text-[11px] text-muted-soft">
              {update.from_status} → {update.to_status}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-soft">
            {timeAgo(update.created_at)}
          </span>
        </div>
        {update.body && <p className="mt-0.5 text-[11px] text-muted-foreground">{update.body}</p>}
        <p className="mt-0.5 text-[10px] text-muted-soft">{author}</p>
      </div>
    </div>
  );
}
