import { CheckIcon } from '@/components/icons';
import type { Task } from '@octomux/types';

interface Props {
  task: Task;
  onViewLogs?: () => void;
}

interface Step {
  status: 'done' | 'active' | 'pending';
  label: string;
}

function buildSteps(task: Task): Step[] {
  const hasWorktree = !!(task.worktree || task.worktree_id);
  const hasTmux = !!task.tmux_session;
  const firstAgent = task.agents?.[0];
  const hasAgent = !!firstAgent;
  const hasOutput = firstAgent?.hook_activity === 'active';

  const worktreeLabel = task.worktree
    ? `Git worktree created · ${task.worktree.split('/').slice(-2).join('/')}`
    : 'Git worktree created';
  const tmuxLabel = task.tmux_session
    ? `tmux session started · ${task.tmux_session}`
    : 'tmux session started';

  return [
    { status: hasWorktree ? 'done' : 'active', label: worktreeLabel },
    {
      status: hasWorktree && hasTmux ? 'done' : hasWorktree ? 'active' : 'pending',
      label: tmuxLabel,
    },
    {
      status: hasAgent ? 'done' : hasTmux ? 'active' : 'pending',
      label: 'Launching Claude Code (opus-4.7)…',
    },
    {
      status: hasOutput ? 'done' : hasAgent ? 'active' : 'pending',
      label: 'Waiting for first output',
    },
  ];
}

export function TaskSettingUpView({ task, onViewLogs }: Props) {
  const steps = buildSteps(task);
  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      data-testid="task-setting-up"
      role="status"
      aria-live="polite"
    >
      <div className="bg-glass-l1 glass-blur-l1 flex w-full max-w-[640px] flex-col items-center gap-6 rounded-2xl border border-glass-edge p-12 text-center shadow-[0_12px_30px_-8px_rgba(0,0,0,0.6)]">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[#FFB800] bg-[#FFB80014] text-[22px] font-bold text-[#FFB800]"
          aria-hidden
        >
          <span className="setting-up-spinner inline-block">◐</span>
        </div>
        <h1 className="text-[20px] font-bold leading-none tracking-tight text-white">
          Setting up task
        </h1>
        <ul className="flex w-full max-w-[440px] flex-col gap-2.5 text-left">
          {steps.map((step, idx) => (
            <li key={idx} className="flex items-center gap-3">
              {step.status === 'done' ? (
                <CheckIcon size={14} className="shrink-0 text-[#22C55E]" />
              ) : step.status === 'active' ? (
                <span
                  className="setting-up-pulse inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-[#FFB800]"
                  aria-hidden
                />
              ) : (
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-[#6a6a6a]"
                  aria-hidden
                />
              )}
              <span
                className={
                  'text-[13px] leading-snug ' +
                  (step.status === 'active'
                    ? 'font-medium text-[#FFB800]'
                    : step.status === 'done'
                      ? 'text-[#D0D0D0]'
                      : 'text-[#6a6a6a]')
                }
              >
                {step.label}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col items-center gap-3">
          <p className="text-[11px] text-[#8a8a8a]">
            Usually takes under 5 seconds. Long? Click 'View logs'.
          </p>
          {onViewLogs && (
            <button
              type="button"
              onClick={onViewLogs}
              className="bg-glass-l1 glass-blur-l1 rounded-md border border-glass-edge px-3 py-1.5 text-[12px] font-medium text-[#D0D0D0] hover:bg-[#FFFFFF14]"
            >
              View logs
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
