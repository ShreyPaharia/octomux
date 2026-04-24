import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../../server/types';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { useInbox } from '@/lib/inbox';
import { useTasksContextOptional } from '@/lib/tasks-context';
import { timeAgo } from '@/lib/time';
import { repoName } from '@/lib/utils';
import { CircleCheckIcon } from '@/components/icons';

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
      className="shrink-0 rounded-[10px] px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase text-[#1f1300] transition-colors hover:brightness-110"
      style={{
        backgroundColor: '#FFB800',
        boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.35), 0 0 16px 0 rgba(255, 184, 0, 0.35)',
      }}
    >
      Reply →
    </button>
  );
}

// Per-mockup: awaiting_reply cards carry amber tint in border + a specular
// top-edge; errored cards use red-tinted border; activity rows stay L1 glass.
function cardStyleFor(kind: RowKind): { style: CSSProperties; className: string } {
  if (kind === 'awaiting_reply') {
    return {
      className: 'border-[#FFB80040]',
      style: {
        backgroundColor: 'rgba(255, 255, 255, 0.10)',
        boxShadow:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.22), 0 12px 30px -8px rgba(0, 0, 0, 0.55)',
      },
    };
  }
  return {
    className: 'border-[#EF444440]',
    style: {
      backgroundColor: 'rgba(255, 255, 255, 0.10)',
      boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.22), 0 12px 30px -8px rgba(0, 0, 0, 0.55)',
    },
  };
}

function InboxCard({ task, kind }: { task: Task; kind: RowKind }) {
  const navigate = useNavigate();
  const { style, className } = cardStyleFor(kind);
  return (
    <GlassPanel
      level={2}
      data-testid={`inbox-row-${task.id}`}
      className={`group flex items-center gap-3 rounded-[16px] px-5 py-4 transition-colors hover:bg-glass-l3 ${className}`}
      style={style}
    >
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <StatusGlyph status={glyphStatusFor(kind)} size={12} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{task.title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {subtitleFor(task, kind)}
            </span>
          </span>
          <span className="font-mono text-[11px] text-[#8a8a8a]">
            {repoName(task.repo_path)} · {timeAgo(task.updated_at)}
          </span>
        </span>
      </button>
      {kind === 'awaiting_reply' && <ReplyButton taskId={task.id} />}
    </GlassPanel>
  );
}

function ActivityRow({ task }: { task: Task }) {
  const navigate = useNavigate();
  return (
    <GlassPanel
      level={1}
      data-testid={`inbox-row-${task.id}`}
      className="group flex items-center gap-4 rounded-[12px] px-4 py-2.5 transition-colors hover:bg-glass-l2"
    >
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <StatusGlyph status="closed" size={10} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#B5B5BD]">
          {task.title}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-[#6a6a6a]">
          {repoName(task.repo_path)} · closed · {timeAgo(task.updated_at)}
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
    <section data-testid={testId} className="flex flex-col gap-3">
      <h3 className="flex items-baseline gap-2 px-1 text-[10px] font-bold uppercase tracking-wider text-[#B5B5BD]">
        {eyebrow && (
          <span className="font-mono text-[#6a6a6a]" style={{ letterSpacing: '1.5px' }}>
            {eyebrow}
          </span>
        )}
        <span>{title}</span>
      </h3>
      <div className="flex flex-col gap-3">
        {tasks.map((t) => (
          <InboxCard key={t.id} task={t} kind={kind} />
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
    <section data-testid="inbox-section-activity" className="flex flex-col gap-2">
      <div
        className="flex items-baseline gap-2 border-t border-[#FFFFFF14] px-1 pt-4 text-[10px] font-bold uppercase tracking-wider text-[#B5B5BD]"
      >
        <span className="font-mono text-[#6a6a6a]" style={{ letterSpacing: '1.5px' }}>
          //
        </span>
        <span>Activity</span>
      </div>
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
          className="self-start px-1 py-1 text-[11px] font-medium text-[#8a8a8a] hover:text-foreground"
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

  const runningCount = useMemo(() => tasks.filter((t) => t.status === 'running').length, [tasks]);

  const isEmpty =
    !loading && awaitingReply.length === 0 && errored.length === 0 && activity.length === 0;
  const isInboxZero = !loading && !isEmpty && awaitingReply.length === 0 && errored.length === 0;

  return (
    <div data-testid="sessions-inbox" className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between px-1">
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
            <div
              data-testid="inbox-zero"
              className="bg-glass-l2 glass-blur-l2 flex flex-col items-center gap-3 rounded-[16px] border border-glass-edge px-6 py-8 text-center"
            >
              <div
                className="flex h-12 w-12 items-center justify-center rounded-full border border-[#22C55E66] bg-[#22C55E1F]"
                aria-hidden
              >
                <CircleCheckIcon size={20} className="text-[#22C55E]" />
              </div>
              <h3 className="text-[16px] font-bold tracking-tight text-white">Inbox zero</h3>
              <p className="max-w-sm text-[13px] leading-relaxed text-[#B5B5BD]">
                Nothing needs your attention.
                {runningCount > 0
                  ? ` Your ${runningCount} running ${runningCount === 1 ? 'agent' : 'agents'} will ping you when they're blocked.`
                  : ''}
              </p>
            </div>
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
            </>
          )}
          <ActivitySection tasks={activity} />
        </>
      )}
    </div>
  );
}
