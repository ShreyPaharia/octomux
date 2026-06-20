/**
 * src/components/orchestrator/PlanCard.tsx
 *
 * Editable plan artifact card (Task 2.6 / SHR-129, spec §6.5, §11).
 *
 * Responsibilities:
 *  - Fetches plan.json from the artifact endpoint (GET) browser-side; the orchestrator
 *    process never sees the plan body — only the pointer travels through its context.
 *  - Renders a Copilot-Workspace-style editable file-level change list: each file
 *    has a toggle (include/exclude), an action badge (create/modify/delete/rename), and
 *    expandable per-file steps.
 *  - Shows open_questions when present so the user can review them before approving.
 *  - Approve: PUT the edited plan (excluded files removed) back to the artifact endpoint,
 *    then fire onDecision({ decision:'approve', card_id }).
 *  - Reject: fire onDecision({ decision:'reject', card_id }) immediately, no PUT.
 *  - Prose fallback: when plan.json fails schema validation (missing required fields),
 *    renders the `detail` / summary as plain markdown-text rather than a file list.
 *  - Loading skeleton while fetching; error alert on network failure.
 *
 * Architecture — pointers-not-contents:
 *  The PlanCard receives only `artifactUrl` (the REST pointer). It fetches and renders
 *  the contents browser-side. The edited plan is PUT back. Artifact body never enters
 *  the orchestrator's tmux/LLM context.
 */

import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

// ─── Plan types (mirrors plan-schema.json) ─────────────────────────────────────

export type PlanAction = 'create' | 'modify' | 'delete' | 'rename';

export interface PlanFileEntry {
  path: string;
  action: PlanAction;
  steps?: string[];
  rename_to?: string;
}

export interface PlanJson {
  schema_version: string;
  summary: string;
  files: PlanFileEntry[];
  open_questions?: string[];
  detail?: string;
}

// ─── Card decision ─────────────────────────────────────────────────────────────

export interface CardDecision {
  decision: 'approve' | 'reject';
  card_id: string;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface PlanCardProps {
  /** The action_cards.id for this card (sent back to ws on decision). */
  cardId: string;
  /** The task that owns the plan artifact. */
  taskId: string;
  /** The path within the task's worktree (e.g. 'plan.json'). */
  planPath: string;
  /** The full artifact REST endpoint URL for fetching/writing the plan. */
  artifactUrl: string;
  /** Called when the user approves or rejects. */
  onDecision: (decision: CardDecision) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Action badge colour map. */
const ACTION_COLOURS: Record<PlanAction, string> = {
  create: 'bg-[#22C55E]',
  modify: 'bg-[#3B82F6]',
  delete: 'bg-[#EF4444]',
  rename: 'bg-[#F59E0B]',
};

/** Minimal schema validation: requires schema_version + summary + files array. */
function validatePlan(raw: unknown): raw is PlanJson {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Record<string, unknown>;
  return (
    typeof p['schema_version'] === 'string' &&
    typeof p['summary'] === 'string' &&
    Array.isArray(p['files'])
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Loading skeleton displayed while the artifact fetch is in-flight. */
function LoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading plan"
      className="space-y-3 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-4"
    >
      <div className="h-3 w-3/5 animate-pulse rounded bg-[rgba(255,255,255,0.08)]" />
      <div className="h-3 w-4/5 animate-pulse rounded bg-[rgba(255,255,255,0.06)]" />
      <div className="h-3 w-2/5 animate-pulse rounded bg-[rgba(255,255,255,0.06)]" />
      <span className="sr-only">Loading plan artifact…</span>
    </div>
  );
}

/** Error alert rendered when the artifact fetch fails. */
function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#EF4444]/30 bg-[#EF4444]/10 px-4 py-3 text-sm text-[#EF4444]"
    >
      <strong>Failed to load plan:</strong> {message}
    </div>
  );
}

/** Prose fallback when schema validation fails. */
function ProseFallback({ plan }: { plan: Record<string, unknown> }) {
  const text =
    typeof plan['detail'] === 'string'
      ? plan['detail']
      : typeof plan['summary'] === 'string'
        ? plan['summary']
        : 'Plan details unavailable.';
  return (
    <div
      data-testid="plan-prose-fallback"
      className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-4 text-sm text-foreground"
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.45)]">
        Plan (prose)
      </p>
      <pre className="whitespace-pre-wrap leading-relaxed">{text}</pre>
    </div>
  );
}

// ─── FileRow ──────────────────────────────────────────────────────────────────

interface FileRowProps {
  file: PlanFileEntry;
  included: boolean;
  onToggle: (path: string) => void;
}

function FileRow({ file, included, onToggle }: FileRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasSteps = Array.isArray(file.steps) && file.steps.length > 0;
  const badgeColour = ACTION_COLOURS[file.action] ?? 'bg-[rgba(255,255,255,0.15)]';

  return (
    <div
      className={cn('rounded-lg border border-[rgba(255,255,255,0.06)]', !included && 'opacity-50')}
    >
      {/* Main row */}
      <div
        data-testid={`file-row-${file.path}`}
        className="flex cursor-pointer items-center gap-2 px-3 py-2"
        onClick={() => hasSteps && setExpanded((v) => !v)}
        role={hasSteps ? 'button' : undefined}
        aria-expanded={hasSteps ? expanded : undefined}
        aria-label={hasSteps ? `Expand steps for ${file.path}` : undefined}
      >
        {/* Include/exclude toggle */}
        <input
          type="checkbox"
          checked={included}
          onChange={() => onToggle(file.path)}
          aria-label={file.path}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#3B82F6]"
        />

        {/* Action badge */}
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white',
            badgeColour,
          )}
        >
          {file.action}
        </span>

        {/* Path */}
        <span className="flex-1 truncate font-mono text-xs text-foreground">{file.path}</span>

        {/* Rename target */}
        {file.action === 'rename' && file.rename_to && (
          <span className="shrink-0 truncate font-mono text-xs text-[rgba(255,255,255,0.45)]">
            → {file.rename_to}
          </span>
        )}

        {/* Expand chevron */}
        {hasSteps && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            className={cn(
              'shrink-0 text-[rgba(255,255,255,0.35)] transition-transform',
              expanded && 'rotate-180',
            )}
          >
            <path
              d="M2 4l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>

      {/* Expanded steps */}
      {hasSteps && expanded && (
        <ol className="border-t border-[rgba(255,255,255,0.06)] px-4 py-2 text-xs text-[rgba(255,255,255,0.65)]">
          {file.steps!.map((step, i) => (
            <li key={i} className="py-0.5">
              <span className="mr-2 text-[rgba(255,255,255,0.3)]">{i + 1}.</span>
              {step}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ─── PlanCard ─────────────────────────────────────────────────────────────────

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'invalid'; raw: Record<string, unknown> }
  | { status: 'ready'; plan: PlanJson; etag: string };

export function PlanCard({
  cardId,
  taskId: _taskId,
  planPath: _planPath,
  artifactUrl,
  onDecision,
}: PlanCardProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });
  /** Set of file paths that are currently included (checked). */
  const [includedPaths, setIncludedPaths] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // ── Fetch the plan artifact on mount ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(artifactUrl);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          if (!cancelled) {
            setFetchState({
              status: 'error',
              message: (body as { error?: string }).error ?? res.statusText,
            });
          }
          return;
        }
        const etag = res.headers.get('etag') ?? '';
        const raw = await res.json();
        if (cancelled) return;

        if (validatePlan(raw)) {
          setFetchState({ status: 'ready', plan: raw, etag });
          setIncludedPaths(new Set(raw.files.map((f) => f.path)));
        } else {
          setFetchState({ status: 'invalid', raw: raw as Record<string, unknown> });
        }
      } catch (err) {
        if (!cancelled) {
          setFetchState({ status: 'error', message: String(err) });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [artifactUrl]);

  // ── Toggle file inclusion ─────────────────────────────────────────────────
  const handleToggle = useCallback((path: string) => {
    setIncludedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // ── Approve ───────────────────────────────────────────────────────────────
  const handleApprove = useCallback(async () => {
    if (fetchState.status !== 'ready' || submitting) return;
    setSubmitting(true);
    try {
      const { plan, etag } = fetchState;
      // Build the edited plan with only the included files
      const editedPlan: PlanJson = {
        ...plan,
        files: plan.files.filter((f) => includedPaths.has(f.path)),
      };
      // PUT edited plan back (conditional — if-match etag)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (etag) {
        headers['If-Match'] = etag;
      }
      await fetch(artifactUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(editedPlan),
      });
      // Fire the card decision
      onDecision({ decision: 'approve', card_id: cardId });
    } finally {
      setSubmitting(false);
    }
  }, [fetchState, submitting, includedPaths, artifactUrl, cardId, onDecision]);

  // ── Reject ────────────────────────────────────────────────────────────────
  const handleReject = useCallback(() => {
    onDecision({ decision: 'reject', card_id: cardId });
  }, [cardId, onDecision]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (fetchState.status === 'loading') return <LoadingSkeleton />;
  if (fetchState.status === 'error') return <ErrorAlert message={fetchState.message} />;
  if (fetchState.status === 'invalid') return <ProseFallback plan={fetchState.raw} />;

  const { plan } = fetchState;

  return (
    <div
      className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)]"
      data-testid="plan-card"
    >
      {/* Header */}
      <div className="border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
        <p className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.45)]">
          Plan — review &amp; approve
        </p>
        <p className="text-sm font-medium text-foreground">{plan.summary}</p>
      </div>

      {/* File list */}
      <div className="space-y-1 px-4 py-3">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.35)]">
          Files ({plan.files.length})
        </p>
        {plan.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            included={includedPaths.has(file.path)}
            onToggle={handleToggle}
          />
        ))}
      </div>

      {/* Open questions */}
      {plan.open_questions && plan.open_questions.length > 0 && (
        <div className="border-t border-[rgba(255,255,255,0.08)] px-4 py-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.35)]">
            Open questions
          </p>
          <ul className="space-y-1 text-sm text-[rgba(255,255,255,0.65)]">
            {plan.open_questions.map((q, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-[rgba(255,255,255,0.3)]">?</span>
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-end gap-2 border-t border-[rgba(255,255,255,0.08)] px-4 py-3">
        <button
          type="button"
          onClick={handleReject}
          disabled={submitting}
          aria-label="Reject plan"
          className="rounded-lg border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-sm text-[rgba(255,255,255,0.65)] hover:border-[#EF4444]/50 hover:text-[#EF4444] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => void handleApprove()}
          disabled={submitting || includedPaths.size === 0}
          aria-label="Approve plan"
          className="rounded-lg bg-[#3B82F6] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}
