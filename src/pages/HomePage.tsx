import { Composer } from '@/components/Composer';
import { CommandPalette } from '@/components/CommandPalette';
import { SessionsInbox } from '@/components/SessionsInbox';
import { useInbox } from '@/lib/inbox';
import { useTasksContext } from '@/lib/tasks-context';
import { RocketIcon } from '@/components/icons';

function todayLabel(): string {
  const d = new Date();
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const day = d.getDate();
  return `${weekday} ${month} ${day}`;
}

function FirstRunEmptyState() {
  const focusComposer = () => {
    window.dispatchEvent(new CustomEvent('focus-composer'));
  };
  return (
    <div
      data-testid="home-first-run"
      className="bg-glass-l2 glass-blur-l2 mx-auto flex max-w-xl flex-col items-center gap-5 rounded-2xl border border-glass-edge p-12 text-center shadow-[0_12px_30px_-8px_rgba(0,0,0,0.6)]"
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full border border-[#3B82F666] bg-[#3B82F61F]"
        aria-hidden
      >
        <RocketIcon size={22} className="text-[#3B82F6]" />
      </div>
      <h2 className="text-[20px] font-bold leading-tight tracking-tight text-white">
        Ship work faster with Claude
      </h2>
      <p className="max-w-sm text-[13px] leading-relaxed text-[#B5B5BD]">
        Dispatch autonomous agents to fix bugs and build features. Each task gets its own git
        worktree and tmux session.
      </p>
      <button
        type="button"
        data-testid="home-first-run-cta"
        onClick={focusComposer}
        className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-4 py-2.5 text-[13px] font-bold text-white shadow-[0_6px_20px_-4px_rgba(59,130,246,0.6)] hover:bg-[#2563EB]"
      >
        Create your first task
      </button>
    </div>
  );
}

export default function HomePage() {
  const { tasks, loading } = useTasksContext();
  const { needsYou } = useInbox();
  const isFirstRun = !loading && tasks.length === 0;
  const needsCount = needsYou.length;

  const attentionMeta =
    needsCount > 0
      ? `${needsCount} session${needsCount === 1 ? '' : 's'} want${needsCount === 1 ? 's' : ''} your attention`
      : 'inbox zero';

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-8 px-[72px] pt-12 pb-[160px]">
          <div className="flex items-end justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <div
                data-testid="home-eyebrow"
                className="flex items-center gap-2 pb-0.5 font-mono text-[11px]"
              >
                <span className="font-bold text-[#B5B5BD]" style={{ letterSpacing: '1.5px' }}>
                  // INBOX
                </span>
                <span className="text-[#6a6a6a]">·</span>
                <span className="text-[#6a6a6a]">{todayLabel()}</span>
                <span className="text-[#6a6a6a]">·</span>
                <span className={needsCount > 0 ? 'text-[#FFB800]' : 'text-[#6a6a6a]'}>
                  {attentionMeta}
                </span>
              </div>
              <h1
                className="font-display text-[32px] font-bold leading-[1.1] tracking-tight text-white"
                style={{ letterSpacing: '-1.2px' }}
              >
                Welcome back
              </h1>
            </div>
            <div data-testid="home-search" className="w-[280px] max-w-full">
              <CommandPalette />
            </div>
          </div>
          <div id="sessions-inbox-slot" data-testid="sessions-inbox-slot">
            {isFirstRun ? <FirstRunEmptyState /> : <SessionsInbox />}
          </div>
        </div>
      </div>
      <div
        data-testid="composer-dock"
        className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center px-[72px]"
      >
        <div className="pointer-events-auto w-full max-w-[1056px]">
          <Composer />
        </div>
      </div>
    </div>
  );
}
