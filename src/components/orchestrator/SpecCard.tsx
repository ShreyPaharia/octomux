/**
 * src/components/orchestrator/SpecCard.tsx
 *
 * Read-only spec artifact card (SHR-143 workflow kind).
 *
 * Responsibilities:
 *  - Fetches spec.md from the artifact endpoint (GET) browser-side.
 *  - Renders the spec text as pre-formatted markdown (plain text pre-wrap).
 *  - Provides a local "Done reviewing" dismiss button — no PUT, no ws decision event.
 *  - Loading skeleton while fetching; error alert on network failure.
 *
 * Architecture — pointers-not-contents:
 *  The SpecCard receives only `artifactUrl` (the REST pointer). It fetches and renders
 *  the contents browser-side. The spec body never enters the orchestrator's LLM context.
 *  Unlike PlanCard there is no approve/reject — the spec is read-only; planning runs
 *  automatically once the spec is written.
 */

import { useState, useEffect, useCallback } from 'react';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SpecCardProps {
  /** The ws card id (not sent back — card is read-only). */
  cardId: string;
  /** The task that owns the spec artifact. */
  taskId: string;
  /** The path within the task's worktree (e.g. 'spec.md'). */
  specPath: string;
  /** The full artifact REST endpoint URL for fetching the spec. */
  artifactUrl: string;
  /** Called when the user clicks "Done reviewing" to locally dismiss the card. */
  onDismiss: () => void;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Loading skeleton displayed while the artifact fetch is in-flight. */
function LoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading spec"
      className="space-y-3 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-4"
    >
      <div className="h-3 w-3/5 animate-pulse rounded bg-[rgba(255,255,255,0.08)]" />
      <div className="h-3 w-4/5 animate-pulse rounded bg-[rgba(255,255,255,0.06)]" />
      <div className="h-3 w-2/5 animate-pulse rounded bg-[rgba(255,255,255,0.06)]" />
      <div className="h-3 w-3/5 animate-pulse rounded bg-[rgba(255,255,255,0.06)]" />
      <span className="sr-only">Loading spec artifact…</span>
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
      <strong>Failed to load spec:</strong> {message}
    </div>
  );
}

// ─── SpecCard ─────────────────────────────────────────────────────────────────

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; text: string };

export function SpecCard({
  cardId: _cardId,
  taskId: _taskId,
  specPath: _specPath,
  artifactUrl,
  onDismiss,
}: SpecCardProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });

  // ── Fetch the spec artifact on mount ──────────────────────────────────────
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
        const text = await res.text();
        if (!cancelled) {
          setFetchState({ status: 'ready', text });
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

  // ── Dismiss ───────────────────────────────────────────────────────────────
  const handleDismiss = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (fetchState.status === 'loading') return <LoadingSkeleton />;
  if (fetchState.status === 'error') return <ErrorAlert message={fetchState.message} />;

  const { text } = fetchState;

  return (
    <div
      className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)]"
      data-testid="spec-card"
    >
      {/* Header */}
      <div className="border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
        <p className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.45)]">
          Spec — read only
        </p>
        <p className="text-xs text-[rgba(255,255,255,0.35)]">
          Planning is underway. Review the spec below.
        </p>
      </div>

      {/* Spec content */}
      <div className="px-4 py-3">
        <pre
          data-testid="spec-content"
          className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"
        >
          {text}
        </pre>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-end border-t border-[rgba(255,255,255,0.08)] px-4 py-3">
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Done reviewing spec"
          className="rounded-lg border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-sm text-[rgba(255,255,255,0.65)] hover:border-[#3B82F6]/50 hover:text-[#3B82F6]"
        >
          Done reviewing
        </button>
      </div>
    </div>
  );
}
