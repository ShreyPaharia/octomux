import type React from 'react';
import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../../server/types';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { useInbox } from '@/lib/inbox';
import { useTasksContextOptional } from '@/lib/tasks-context';
import { timeAgo } from '@/lib/time';
import { repoName } from '@/lib/utils';
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
    <button
      type="button"
      data-testid={`inbox-reply-${taskId}`}
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/?add_agent=${taskId}`);
      }}
      className="shrink-0 rounded-[10px] text-[12px] font-bold text-[#0A0A0B] transition-[filter] hover:brightness-110"
      style={{
        backgroundColor: '#FFB800',
        padding: '8px 14px',
        boxShadow: '0 4px 16px -2px rgba(255, 184, 0, 0.4)',
      }}
    >
      Reply →
    </button>
  );
}

// Card materials per pen frame lBhOV (awaiting) / MYKbE (errored):
// awaiting is the "hot" card — brighter fill, top specular highlight;
// errored dims to L2-low without the specular edge.
function cardStyleFor(kind: RowKind): { style: CSSProperties; borderColor: string } {
  if (kind === 'awaiting_reply') {
    return {
      borderColor: 'rgba(255, 255, 255, 0.12)',
      style: {
        backgroundColor: 'rgba(255, 255, 255, 0.0625)',
        boxShadow:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.18), 0 20px 40px -10px rgba(0, 0, 0, 0.38)',
      },
    };
  }
  return {
    borderColor: 'rgba(255, 255, 255, 0.08)',
    style: {
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
      boxShadow: '0 20px 40px -10px rgba(0, 0, 0, 0.38)',
    },
  };
}

function InboxCard({ task, kind }: { task: Task; kind: RowKind }) {
  const navigate = useNavigate();
  const { style, borderColor } = cardStyleFor(kind);
  return (
    <GlassPanel
      level={2}
      data-testid={`inbox-row-${task.id}`}
      className="group flex items-center gap-4 rounded-[16px] px-[22px] py-[18px] transition-colors"
      style={{ ...style, borderColor }}
    >
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <StatusGlyph status={glyphStatusFor(kind)} size={14} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-white">{task.title}</span>
            <span className="truncate text-xs text-[#8a8a8a]">{subtitleFor(task, kind)}</span>
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
      className="group flex items-center gap-3.5 rounded-[12px] px-[18px] py-3 transition-colors"
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.031)',
        borderColor: 'rgba(255, 255, 255, 0.063)',
      }}
    >
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
      >
        <StatusGlyph status={statusKey} size={12} />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
            isClosed ? 'text-[#8a8a8a]' : 'text-white'
          }`}
        >
          {task.title}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-[#8a8a8a]">
          {repoName(task.repo_path)} · {statusKey.replace('_', ' ')} · {timeAgo(task.updated_at)}
        </span>
      </button>
    </GlassPanel>
  );
}

function SectionHeader({
  accent,
  lineColor,
  icon,
  title,
  count,
  meta,
}: {
  accent: string;
  lineColor?: string;
  icon: React.ReactNode;
  title: string;
  count?: string | number;
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="flex items-center justify-center" style={{ color: accent }} aria-hidden>
        {icon}
      </span>
      <span
        className="font-mono text-[11px] font-bold"
        style={{ color: accent, letterSpacing: '1.5px' }}
      >
        {title}
      </span>
      {count !== undefined && (
        <span className="font-mono text-[11px] font-bold text-[#6a6a6a]">{count}</span>
      )}
      {meta && <span className="font-mono text-[11px] font-medium text-[#6a6a6a]">{meta}</span>}
      <span
        className="ml-1 h-px flex-1"
        style={{ backgroundColor: lineColor ?? `${accent}22` }}
        aria-hidden
      />
    </div>
  );
}

function Section({
  title,
  tasks,
  kind,
  testId,
  accent,
  icon,
}: {
  title: string;
  tasks: Task[];
  kind: RowKind;
  testId: string;
  accent: string;
  icon: React.ReactNode;
}) {
  if (tasks.length === 0) return null;
  return (
    <section data-testid={testId} className="flex flex-col gap-3">
      <SectionHeader accent={accent} icon={icon} title={title} count={tasks.length} />
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
      ? `${runningCount} running  ·  tap to expand`
      : tasks.length > ACTIVITY_COLLAPSED_LIMIT
        ? 'tap to expand'
        : undefined;
  return (
    <section data-testid="inbox-section-activity" className="flex flex-col gap-2">
      <SectionHeader
        accent="#22C55E"
        lineColor="rgba(34, 197, 94, 0.08)"
        icon={<ActivityIcon size={14} />}
        title="ACTIVITY"
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
            className="text-[11px] font-medium text-[#8a8a8a] hover:text-foreground"
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
                title="AWAITING REPLY"
                tasks={awaitingReply}
                kind="awaiting_reply"
                testId="inbox-section-awaiting_reply"
                accent="#FFB800"
                icon={<TriangleAlertIcon size={14} />}
              />
              <Section
                title="ERRORED"
                tasks={errored}
                kind="errored"
                testId="inbox-section-errored"
                accent="#EF4444"
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
