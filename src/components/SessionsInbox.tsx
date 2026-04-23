import { useNavigate } from 'react-router-dom';
import type { Task } from '../../server/types';
import { useInbox } from '@/lib/inbox';
import { timeAgo } from '@/lib/time';
import { repoName } from '@/lib/utils';
import { cn } from '@/lib/utils';

type RowKind = 'needs_you' | 'activity';

function pendingPromptCount(task: Task): number {
  return (task.pending_prompts?.length ?? 0) as number;
}

function subtitleFor(task: Task, kind: RowKind): string {
  if (kind === 'activity') return 'closed';
  if (task.status === 'error') return task.error ? `errored · ${task.error}` : 'errored';
  const prompts = pendingPromptCount(task);
  if (prompts > 0)
    return prompts === 1 ? 'permission prompt open' : `${prompts} permission prompts`;
  return 'needs attention';
}

function Glyph({ kind, task }: { kind: RowKind; task: Task }) {
  if (kind === 'needs_you') {
    const isError = task.status === 'error';
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex h-4 w-4 items-center justify-center text-sm',
          isError ? 'text-[#EF4444]' : 'text-[#FFB800]',
        )}
      >
        {isError ? '✕' : '⚠'}
      </span>
    );
  }
  return (
    <span aria-hidden className="inline-flex h-4 w-4 items-center justify-center text-[#22C55E]">
      ✓
    </span>
  );
}

function InboxRow({ task, kind }: { task: Task; kind: RowKind }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid={`inbox-row-${task.id}`}
      onClick={() => navigate(`/tasks/${task.id}`)}
      className="group flex w-full items-center gap-3 rounded border border-transparent px-3 py-2 text-left transition-colors hover:border-[#2f2f2f] hover:bg-[#141414]"
    >
      <Glyph kind={kind} task={task} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
        <span className="truncate text-xs text-muted-foreground">{subtitleFor(task, kind)}</span>
      </span>
      <span className="shrink-0 text-[11px] text-[#6a6a6a]">
        {repoName(task.repo_path)} · {timeAgo(task.updated_at)}
      </span>
    </button>
  );
}

function Section({ title, tasks, kind }: { title: string; tasks: Task[]; kind: RowKind }) {
  if (tasks.length === 0) return null;
  return (
    <section data-testid={`inbox-section-${kind}`} className="flex flex-col gap-1">
      <h3 className="px-3 text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
        {title}
      </h3>
      <div className="flex flex-col">
        {tasks.map((t) => (
          <InboxRow key={t.id} task={t} kind={kind} />
        ))}
      </div>
    </section>
  );
}

export function SessionsInbox() {
  const { needsYou, activity, loading, error, markAllRead } = useInbox();
  const isEmpty = !loading && needsYou.length === 0 && activity.length === 0;

  return (
    <div data-testid="sessions-inbox" className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between px-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[#6a6a6a]">
          Sessions
        </h2>
        {(needsYou.length > 0 || activity.length > 0) && (
          <button
            type="button"
            data-testid="inbox-mark-all-read"
            onClick={() => void markAllRead()}
            className="text-[11px] font-medium text-[#8a8a8a] hover:text-foreground"
          >
            Mark all read
          </button>
        )}
      </div>

      {error && (
        <p data-testid="inbox-error" className="px-3 text-xs text-destructive">
          {error}
        </p>
      )}

      {isEmpty ? (
        <p
          data-testid="inbox-empty"
          className="px-3 py-8 text-center text-sm text-muted-foreground"
        >
          You&rsquo;re all caught up
        </p>
      ) : (
        <>
          <Section title="Needs you" tasks={needsYou} kind="needs_you" />
          <Section title="Activity" tasks={activity} kind="activity" />
        </>
      )}
    </div>
  );
}
