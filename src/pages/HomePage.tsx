import { Composer } from '@/components/Composer';
import { SessionsInbox } from '@/components/SessionsInbox';
import { useTasksContext } from '@/lib/tasks-context';
import { RocketIcon } from '@/components/icons';

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
        <span className="font-mono text-[11px] text-white/80">⌘N</span>
      </button>
    </div>
  );
}

export default function HomePage() {
  const { tasks, loading } = useTasksContext();
  const isFirstRun = !loading && tasks.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-8 py-12">
          <div className="flex flex-col gap-2">
            <span
              data-testid="page-eyebrow"
              className="font-mono text-[11px] font-bold text-[#B5B5BD]"
              style={{ letterSpacing: '1.5px' }}
            >
              // INBOX
            </span>
            <h1
              className="font-display text-[32px] font-bold leading-[1.1] tracking-tight"
              style={{ letterSpacing: '-0.5px' }}
            >
              Welcome back
            </h1>
          </div>
          <div id="sessions-inbox-slot" data-testid="sessions-inbox-slot" className="mt-8">
            {isFirstRun ? <FirstRunEmptyState /> : <SessionsInbox />}
          </div>
        </div>
      </div>
      <Composer />
    </div>
  );
}
