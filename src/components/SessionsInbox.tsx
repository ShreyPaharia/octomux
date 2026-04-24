import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../../server/types';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { useInbox } from '@/lib/inbox';
import { timeAgo } from '@/lib/time';
import { repoName } from '@/lib/utils';
import { cn } from '@/lib/utils';

type RowKind = 'awaiting_reply' | 'errored' | 'activity';

const ACTIVITY_COLLAPSED_LIMIT = 3;

function pendingPromptCount(task: Task): number {
  return task.pending_prompts?.length ?? 0;
}

function isErrored(task: Task): boolean {
  if (task.status === 'error') return true;
  const derived = task.derived_status as string | null | undefined;
  return derived === 'error';
}

function subtitleFor(task: Task, kind: RowKind): string {
  if (kind === 'activity') return 'closed';
  if (kind === 'errored') return task.error ? `errored · ${task.error}` : 'errored';
  const prompts = pendingPromptCount(task);
  if (prompts > 0)
    return prompts === 1 ? 'permission prompt open' : `${prompts} permission prompts`;
  return 'awaiting reply';
}

function glyphStatusFor(kind: RowKind): string {
  if (kind === 'awaiting_reply') return 'awaiting';
  if (kind === 'errored') return 'error';
  return 'closed';
}

function ReplyButton({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid={`inbox-reply-${taskId}`}
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/?add_agent=${taskId}`);
      }}
      className="shrink-0 px-2.5 py-1 text-[11px] font-bold tracking-wider uppercase text-[#1f1300] transition-colors hover:brightness-110"
      style={{
        backgroundColor: '#FFB800',
        boxShadow:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.35), 0 0 16px 0 rgba(255, 184, 0, 0.35)',
      }}
    >
      Reply →
    </button>
  );
}

function InboxRow({ task, kind }: { task: Task; kind: RowKind }) {
  const navigate = useNavigate();
  return (
    <div
      data-testid={`inbox-row-${task.id}`}
      className="group flex w-full items-center gap-3 border border-transparent px-3 py-2 transition-colors hover:border-[#2f2f2f] hover:bg-[#141414]"
    >
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <StatusGlyph status={glyphStatusFor(kind)} size={12} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
          <span className="truncate text-xs text-muted-foreground">{subtitleFor(task, kind)}</span>
        </span>
        <span className="shrink-0 text-[11px] text-[#6a6a6a]">
          {repoName(task.repo_path)} · {timeAgo(task.updated_at)}
        </span>
      </button>
      {kind === 'awaiting_reply' && <ReplyButton taskId={task.id} />}
    </div>
  );
}

function Section({
  title,
  tasks,
  kind,
  testId,
  eyebrow,
}: {
  title: string;
  tasks: Task[];
  kind: RowKind;
  testId: string;
  eyebrow?: string;
}) {
  if (tasks.length === 0) return null;
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <h3 className="flex items-baseline gap-2 px-3 text-[10px] font-bold uppercase tracking-wider text-[#B5B5BD]">
        {eyebrow && (
          <span className="font-mono text-[#6a6a6a]" style={{ letterSpacing: '1.5px' }}>
            {eyebrow}
          </span>
        )}
        <span>{title}</span>
      </h3>
      <div className="flex flex-col">
        {tasks.map((t) => (
          <InboxRow key={t.id} task={t} kind={kind} />
        ))}
      </div>
    </section>
  );
}

function ActivitySection({ tasks }: { tasks: Task[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tasks.length === 0) return null;
  const collapsed = !expanded && tasks.length > ACTIVITY_COLLAPSED_LIMIT;
  const visible = collapsed ? tasks.slice(0, ACTIVITY_COLLAPSED_LIMIT) : tasks;
  const hidden = tasks.length - visible.length;
  return (
    <section data-testid="inbox-section-activity" className="flex flex-col gap-1">
      <h3 className="flex items-baseline gap-2 px-3 text-[10px] font-bold uppercase tracking-wider text-[#B5B5BD]">
        <span className="font-mono text-[#6a6a6a]" style={{ letterSpacing: '1.5px' }}>
          //
        </span>
        <span>Activity</span>
      </h3>
      <div className="flex flex-col">
        {visible.map((t) => (
          <InboxRow key={t.id} task={t} kind="activity" />
        ))}
      </div>
      {tasks.length > ACTIVITY_COLLAPSED_LIMIT && (
        <button
          type="button"
          data-testid="inbox-activity-toggle"
          onClick={() => setExpanded((v) => !v)}
          className="self-start px-3 py-1 text-[11px] font-medium text-[#8a8a8a] hover:text-foreground"
        >
          {collapsed ? `Tap to expand (${hidden} more)` : 'Collapse'}
        </button>
      )}
    </section>
  );
}

export function SessionsInbox() {
  const { needsYou, activity, loading, error, markAllRead } = useInbox();

  const { awaitingReply, errored } = useMemo(() => {
    const awaitingReply: Task[] = [];
    const errored: Task[] = [];
    for (const t of needsYou) {
      if (isErrored(t)) errored.push(t);
      else awaitingReply.push(t);
    }
    return { awaitingReply, errored };
  }, [needsYou]);

  const isEmpty =
    !loading && awaitingReply.length === 0 && errored.length === 0 && activity.length === 0;

  return (
    <GlassPanel
      level={1}
      specular
      data-testid="sessions-inbox"
      className={cn('flex flex-col gap-5 p-4')}
      style={{ borderRadius: '14px' }}
    >
      <div className="flex items-baseline justify-between px-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[#6a6a6a]">
          Sessions
        </h2>
        {(awaitingReply.length > 0 || errored.length > 0 || activity.length > 0) && (
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
          <Section
            title="Awaiting reply"
            tasks={awaitingReply}
            kind="awaiting_reply"
            testId="inbox-section-awaiting_reply"
            eyebrow="//"
          />
          <Section
            title="Errored"
            tasks={errored}
            kind="errored"
            testId="inbox-section-errored"
            eyebrow="//"
          />
          <ActivitySection tasks={activity} />
        </>
      )}
    </GlassPanel>
  );
}
