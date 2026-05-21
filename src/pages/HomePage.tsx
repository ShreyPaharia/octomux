import { Composer } from '@/components/Composer';
import { CommandPalette } from '@/components/CommandPalette';
import { SessionsInbox } from '@/components/SessionsInbox';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
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
      className="bg-glass-l2 glass-blur-l2 motion-fade-in mx-auto flex max-w-xl flex-col items-center gap-5 rounded-2xl border border-glass-edge p-12 text-center shadow-[0_12px_30px_-8px_rgba(0,0,0,0.5)]"
    >
      <div
        className="flex size-14 items-center justify-center rounded-full border border-primary/40 bg-primary/10"
        aria-hidden
      >
        <RocketIcon size={22} className="text-primary" />
      </div>
      <h2 className="font-display text-xl font-semibold leading-tight tracking-tight text-foreground">
        Ship work faster with Claude
      </h2>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        Dispatch autonomous agents to fix bugs and build features. Each task gets its own git
        worktree and tmux session.
      </p>
      <Button
        type="button"
        data-testid="home-first-run-cta"
        onClick={focusComposer}
        className="btn-primary-glow"
      >
        Create your first task
      </Button>
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
        <div className="motion-fade-in flex flex-col gap-8 px-[72px] pt-12 pb-[160px]">
          <PageHeader
            title="Welcome back"
            eyebrowTestId="home-eyebrow"
            eyebrowContent={
              <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                <span>Inbox</span>
                <span className="text-muted-soft">·</span>
                <span className="text-muted-soft">{todayLabel()}</span>
                <span className="text-muted-soft">·</span>
                <span className={needsCount > 0 ? 'text-warning' : 'text-muted-soft'}>
                  {attentionMeta}
                </span>
              </div>
            }
            actions={
              <div data-testid="home-search" className="w-[280px] max-w-full">
                <CommandPalette />
              </div>
            }
          />
          <div id="sessions-inbox-slot" data-testid="sessions-inbox-slot">
            {isFirstRun ? <FirstRunEmptyState /> : <SessionsInbox />}
          </div>
        </div>
      </div>
      <div
        data-testid="composer-dock"
        className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center px-[72px]"
      >
        <div className="pointer-events-auto w-full max-w-[1056px] motion-fade-in">
          <Composer />
        </div>
      </div>
    </div>
  );
}
