import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../../server/types';
import { InboxSectionHeader } from '@/components/layout/inbox-section-header';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { useInbox } from '@/lib/inbox';
import { useTasksContextOptional } from '@/lib/tasks-context';
import { timeAgo } from '@/lib/time';
import { repoName } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { ActivityIcon, CircleCheckIcon, TriangleAlertIcon } from '@/components/icons';

type RowKind = 'awaiting_reply' | 'errored' | 'activity';

const ACTIVITY_COLLAPSED_LIMIT = 3;

function pendingPromptCount(task: Task): number {
  return task.pending_prompts?.length ?? 0;
}

function isErrored(task: Task): boolean {
  if (task.runtime_state === 'error') return true;
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
    <Button
      type="button"
      size="sm"
      data-testid={`inbox-reply-${taskId}`}
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/?add_agent=${taskId}`);
      }}
      className="shrink-0 bg-warning text-[#0a0a0b] hover:bg-warning/90"
      style={{ boxShadow: '0 4px 16px -2px rgba(255, 184, 0, 0.35)' }}
    >
      Reply →
    </Button>
  );
}

function inboxCardClass(kind: RowKind): string {
  return cn(
    'group flex items-center gap-4 rounded-2xl px-5 py-4 transition-all duration-150 hover:bg-glass-l3/30',
    kind === 'awaiting_reply' && 'inbox-card-hot',
    kind === 'errored' && 'inbox-card-muted',
  );
}

function InboxCard({ task, kind }: { task: Task; kind: RowKind }) {
  const navigate = useNavigate();
  return (
    <GlassPanel
      level={2}
      specular={kind === 'awaiting_reply'}
      data-testid={`inbox-row-${task.id}`}
      className={inboxCardClass(kind)}
    >
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <StatusGlyph status={glyphStatusFor(kind)} size={14} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-foreground">{task.title}</span>
            <span className="truncate text-xs text-muted-soft">{subtitleFor(task, kind)}</span>
          </span>
          <span className="font-mono text-[11px] text-muted-soft">
            {repoName(task.repo_path)} · {timeAgo(task.updated_at)}
          </span>
        </span>
      </button>
      {kind === 'awaiting_reply' && <ReplyButton taskId={task.id} />}
    </GlassPanel>
  );
}

function activityStatusKey(task: Task): string {
  if (task.runtime_state === 'running') return 'running';
  if (task.runtime_state === 'setting_up') return 'setting_up';
  if (task.runtime_state === 'error') return 'error';
  return 'closed';
}

function ActivityRow({ task }: { task: Task }) {
  const navigate = useNavigate();
  const statusKey = activityStatusKey(task);
  const isClosed = statusKey === 'closed';
  return (
    <GlassPanel
      level={1}
      data-testid={`inbox-row-${task.id}`}
      className="group flex items-center gap-3 rounded-xl px-4 py-2.5 transition-colors duration-150 hover:bg-glass-l2/40"
    >
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <StatusGlyph status={statusKey} size={12} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm font-medium',
            isClosed ? 'text-muted-soft' : 'text-foreground',
          )}
        >
          {task.title}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-soft">
          {repoName(task.repo_path)} · {statusKey.replace('_', ' ')} · {timeAgo(task.updated_at)}
        </span>
      </button>
    </GlassPanel>
  );
}

function Section({
  title,
  tasks,
  kind,
  testId,
  accentClass,
  icon,
}: {
  title: string;
  tasks: Task[];
  kind: RowKind;
  testId: string;
  accentClass: string;
  icon: React.ReactNode;
}) {
  if (tasks.length === 0) return null;
  return (
    <section data-testid={testId} className="motion-fade-in flex flex-col gap-3">
      <InboxSectionHeader accentClass={accentClass} icon={icon} title={title} count={tasks.length} />
      <div className="flex flex-col gap-3">
        {tasks.map((t) => (
          <InboxCard key={t.id} task={t} kind={kind} />
        ))}
      </div>
    </section>
  );
}

function ActivitySection({ tasks, runningCount }: { tasks: Task[]; runningCount: number }) {
  const [expanded, setExpanded] = useState(false);
  if (tasks.length === 0) return null;
  const collapsed = !expanded && tasks.length > ACTIVITY_COLLAPSED_LIMIT;
  const visible = collapsed ? tasks.slice(0, ACTIVITY_COLLAPSED_LIMIT) : tasks;
  const hidden = tasks.length - visible.length;
  const meta =
    runningCount > 0
      ? `${runningCount} running · tap to expand`
      : tasks.length > ACTIVITY_COLLAPSED_LIMIT
        ? 'tap to expand'
        : undefined;
  return (
    <section data-testid="inbox-section-activity" className="motion-fade-in flex flex-col gap-2">
      <InboxSectionHeader
        accentClass="text-success"
        lineClass="bg-success/10"
        icon={<ActivityIcon size={14} />}
        title="Activity"
        meta={meta}
      />
      <div className="flex flex-col gap-2">
        {visible.map((t) => (
          <ActivityRow key={t.id} task={t} />
        ))}
      </div>
      {tasks.length > ACTIVITY_COLLAPSED_LIMIT && (
        <button
          type="button"
          data-testid="inbox-activity-toggle"
          onClick={() => setExpanded((v) => !v)}
          className="focus-ring self-start rounded-md px-1 py-1 text-xs font-medium text-muted-soft transition-colors hover:text-foreground"
        >
          {collapsed ? `Tap to expand (${hidden} more)` : 'Collapse'}
        </button>
      )}
    </section>
  );
}

export function SessionsInbox() {
  const { needsYou, activity, loading, error, markAllRead } = useInbox();
  const tasksCtx = useTasksContextOptional();
  const tasks = tasksCtx?.tasks ?? [];

  const { awaitingReply, errored } = useMemo(() => {
    const awaitingReply: Task[] = [];
    const errored: Task[] = [];
    for (const t of needsYou) {
      if (isErrored(t)) errored.push(t);
      else awaitingReply.push(t);
    }
    return { awaitingReply, errored };
  }, [needsYou]);

  const runningCount = useMemo(
    () => tasks.filter((t) => t.runtime_state === 'running').length,
    [tasks],
  );

  const isEmpty =
    !loading && awaitingReply.length === 0 && errored.length === 0 && activity.length === 0;
  const isInboxZero = !loading && !isEmpty && awaitingReply.length === 0 && errored.length === 0;

  return (
    <div data-testid="sessions-inbox" className="flex flex-col gap-8">
      {(awaitingReply.length > 0 || errored.length > 0 || activity.length > 0) && (
        <div className="flex items-baseline justify-end px-1">
          <button
            type="button"
            data-testid="inbox-mark-all-read"
            onClick={() => void markAllRead()}
            className="focus-ring rounded-md text-xs font-medium text-muted-soft transition-colors hover:text-foreground"
          >
            Mark all read
          </button>
        </div>
      )}

      {error && (
        <p data-testid="inbox-error" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {isEmpty ? (
        <p
          data-testid="inbox-empty"
          className="px-1 py-8 text-center text-sm text-muted-foreground"
        >
          You&rsquo;re all caught up
        </p>
      ) : (
        <>
          {isInboxZero ? (
            <GlassPanel
              level={2}
              specular
              data-testid="inbox-zero"
              className="motion-fade-in flex flex-col items-center gap-3 rounded-2xl px-6 py-8 text-center"
            >
              <div
                className="flex size-12 items-center justify-center rounded-full border border-success/40 bg-success/10"
                aria-hidden
              >
                <CircleCheckIcon size={20} className="text-success" />
              </div>
              <h3 className="font-display text-base font-semibold tracking-tight text-foreground">
                Inbox zero
              </h3>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                Nothing needs your attention.
                {runningCount > 0
                  ? ` Your ${runningCount} running ${runningCount === 1 ? 'agent' : 'agents'} will ping you when they're blocked.`
                  : ''}
              </p>
            </GlassPanel>
          ) : (
            <>
              <Section
                title="Awaiting reply"
                tasks={awaitingReply}
                kind="awaiting_reply"
                testId="inbox-section-awaiting_reply"
                accentClass="text-warning"
                icon={<TriangleAlertIcon size={14} />}
              />
              <Section
                title="Errored"
                tasks={errored}
                kind="errored"
                testId="inbox-section-errored"
                accentClass="text-destructive"
                icon={<TriangleAlertIcon size={14} />}
              />
            </>
          )}
          <ActivitySection tasks={activity} runningCount={runningCount} />
        </>
      )}
    </div>
  );
}
