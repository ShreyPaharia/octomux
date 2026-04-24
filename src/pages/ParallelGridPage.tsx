import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContext } from '@/lib/tasks-context';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { LayoutGridIcon, TriangleAlertIcon } from '@/components/icons';
import type { Task } from '../../server/types';

interface MiniPaneProps {
  task: Task;
  onOpen: () => void;
}

function hasAttention(task: Task): boolean {
  const d = task.derived_status;
  return d === 'needs_attention' || task.status === 'error';
}

function MiniPane({ task, onOpen }: MiniPaneProps) {
  const agents = task.agents ?? [];
  const activeAgent = agents.find((a) => a.status === 'running') || agents[0];
  const lines: string[] = [
    `branch: ${task.branch ?? '—'}`,
    `agents: ${agents.length}`,
    activeAgent ? `label: ${activeAgent.label}` : '',
    activeAgent?.hook_activity ? `activity: ${activeAgent.hook_activity}` : '',
  ].filter(Boolean);
  const attention = hasAttention(task);
  return (
    <button
      type="button"
      data-testid={`grid-pane-${task.id}`}
      onClick={onOpen}
      className="group flex h-[260px] flex-col overflow-hidden rounded-xl border border-glass-edge bg-[#0B0C0F] text-left shadow-[0_8px_20px_-6px_rgba(0,0,0,0.5)] transition hover:border-[#3B82F666]"
    >
      <header
        className="flex items-center gap-2 border-b bg-[#FFFFFF08] px-3 py-2"
        style={
          attention
            ? { borderBottomColor: 'rgba(255,255,255,0.08)', borderLeft: '2px solid #FFB800' }
            : { borderBottomColor: 'rgba(255,255,255,0.08)' }
        }
      >
        <span
          className="flex-1 truncate font-mono text-[11px] font-medium text-white"
          title={task.branch || task.title}
        >
          {task.branch || task.title}
        </span>
        <StatusGlyph status={task.derived_status || task.status} size={10} />
      </header>
      <div className="flex-1 overflow-hidden px-4 py-3 font-mono text-[11px] leading-snug text-[#8a8a8a]">
        {lines.map((line, idx) => (
          <div key={idx} className="truncate">
            {line}
          </div>
        ))}
      </div>
      <footer className="flex items-center gap-2 border-t border-[#FFFFFF0A] bg-[#FFFFFF05] px-3 py-1.5 font-mono text-[10px] text-[#8a8a8a]">
        <span>opus-4.7</span>
        <div className="flex-1" />
        <span className="text-[#B5B5BD]">
          {agents.length} agent{agents.length === 1 ? '' : 's'}
        </span>
      </footer>
    </button>
  );
}

export default function ParallelGridPage() {
  const navigate = useNavigate();
  const { tasks } = useTasksContext();

  const { running, waiting, errored } = useMemo(() => {
    const running: Task[] = [];
    const waiting: Task[] = [];
    const errored: Task[] = [];
    for (const t of tasks) {
      if (t.status === 'error') errored.push(t);
      else if (hasAttention(t)) waiting.push(t);
      else if (t.status === 'running' || t.status === 'setting_up') running.push(t);
    }
    return { running, waiting, errored };
  }, [tasks]);

  const visible = useMemo(
    () => [...running, ...waiting, ...errored].slice(0, 12),
    [running, waiting, errored],
  );

  return (
    <div className="flex h-full flex-col p-6" data-testid="parallel-grid-page">
      <div className="bg-glass-l1 glass-blur-l1 mb-4 flex items-center gap-3 rounded-xl border border-glass-edge px-4 py-2.5">
        <LayoutGridIcon size={14} className="text-[#D0D0D0]" />
        <span className="text-[12px] font-semibold text-white">Grid</span>
        <span className="h-4 w-px bg-white/10" />
        <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] text-[#B5B5BD]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#22C55E]" aria-hidden />
          {running.length} running
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] text-[#B5B5BD]">
          <TriangleAlertIcon size={10} className="text-[#FFB800]" />
          {waiting.length} waiting
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] text-[#B5B5BD]">
          <span className="text-[#EF4444]">✕</span>
          {errored.length} errored
        </span>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-[#8a8a8a]">⌘⇧G to toggle grid</span>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-glass-edge bg-[#FFFFFF05] p-12 text-center">
          <div className="flex flex-col items-center gap-2">
            <LayoutGridIcon size={32} className="text-[#6a6a6a]" />
            <span className="text-[14px] font-semibold text-[#D0D0D0]">No active agents</span>
            <span className="text-[12px] text-[#8a8a8a]">
              Running tasks will appear here as panes.
            </span>
          </div>
        </div>
      ) : (
        <div
          data-testid="parallel-grid"
          className="grid flex-1 gap-3.5 overflow-auto"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
        >
          {visible.map((task) => (
            <MiniPane key={task.id} task={task} onOpen={() => navigate(`/tasks/${task.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}
