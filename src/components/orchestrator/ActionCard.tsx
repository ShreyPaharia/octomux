/**
 * src/components/orchestrator/ActionCard.tsx
 *
 * ActionCard UI (Task 3.3 / SHR-132, spec §5, §11).
 *
 * Renders a gated write-action surfaced by the PreToolUse deny-now gate.
 * The card shows the parsed `octomux` command with editable arg fields and
 * four decision buttons:
 *
 *   Approve  — run the command as-is (or with edits if args were changed)
 *   Edit     — implicit: changing a field + Approve becomes decision='edit'
 *   Reject   — do not run the command
 *   Respond  — free-text follow-up turn injected into the orchestrator
 *
 * "Always allow this" — persists a permission_rules row so this command shape
 *  is auto-allowed in future. Hidden for always-ask (destructive) commands.
 *
 * Architecture (pointers-not-contents):
 *   The ActionCard never fetches or renders plan/diff bodies. It only knows the
 *   command name and its structured args (e.g. task_id, title, model). The
 *   backend executes the approved command server-side and injects the result.
 */

import { useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActionCardDecision {
  card_id: string;
  decision: 'approve' | 'edit' | 'reject' | 'respond';
  /** Edited command args — present when decision='edit'. */
  args?: Record<string, unknown>;
  /** Follow-up message text — present when decision='respond'. */
  text?: string;
  /** Whether to persist an always-allow rule for this command shape. */
  always_allow?: boolean;
}

export interface ActionCardProps {
  /** The action_cards.id for this card (sent back in the decision). */
  cardId: string;
  /**
   * The octomux CLI command that was denied (e.g. 'create-task', 'delete-task').
   * Displayed as the card title.
   */
  command: string;
  /**
   * Parsed command arguments — displayed as editable fields.
   * String values are editable; other values are shown read-only.
   */
  args: Record<string, unknown>;
  /**
   * When true, the command is in the always-ask (destructive) tier.
   * The "always allow this" checkbox is hidden and a destructive warning badge
   * is shown.
   */
  alwaysAsk?: boolean;
  /** Called when the user makes a decision (approve/edit/reject/respond). */
  onDecision: (decision: ActionCardDecision) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]';

/** Compares two plain-object args records for shallow equality. */
function argsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

// ─── RespondPanel ─────────────────────────────────────────────────────────────

interface RespondPanelProps {
  cardId: string;
  onDecision: (d: ActionCardDecision) => void;
  onCancel: () => void;
}

function RespondPanel({ cardId, onDecision, onCancel }: RespondPanelProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onDecision({ card_id: cardId, decision: 'respond', text: trimmed });
  }, [text, cardId, onDecision]);

  return (
    <div className="mt-3 flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a follow-up message to the orchestrator…"
        rows={3}
        aria-label="Follow-up message"
        className={cn(
          'w-full resize-none rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)]',
          'px-3 py-2 text-sm text-foreground placeholder:text-[rgba(255,255,255,0.3)]',
          'focus:outline-none focus:ring-1 focus:ring-[#3B82F6]',
        )}
        style={{ minHeight: 72 }}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel respond"
          className={cn(
            'rounded-lg border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-sm',
            'text-[rgba(255,255,255,0.55)] hover:border-[rgba(255,255,255,0.2)] hover:text-white',
            FOCUS_RING,
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={!text.trim()}
          aria-label="Send follow-up message"
          className={cn(
            'rounded-lg bg-[rgba(255,255,255,0.1)] px-3 py-1.5 text-sm font-medium text-white',
            'hover:bg-[rgba(255,255,255,0.15)] disabled:cursor-not-allowed disabled:opacity-40',
            FOCUS_RING,
          )}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ─── ArgField ─────────────────────────────────────────────────────────────────

interface ArgFieldProps {
  argKey: string;
  value: unknown;
  onChange: (key: string, value: string) => void;
}

function ArgField({ argKey, value, onChange }: ArgFieldProps) {
  const inputId = `action-card-arg-${argKey}`;
  const isEditable = typeof value === 'string';

  return (
    <div className="flex items-start gap-2">
      <label
        htmlFor={isEditable ? inputId : undefined}
        className="w-32 shrink-0 pt-1.5 text-xs text-[rgba(255,255,255,0.45)]"
      >
        {argKey}
      </label>
      {isEditable ? (
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => onChange(argKey, e.target.value)}
          aria-label={argKey}
          className={cn(
            'flex-1 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)]',
            'px-2.5 py-1 text-xs text-foreground',
            'focus:outline-none focus:ring-1 focus:ring-[#3B82F6]',
          )}
        />
      ) : (
        <span
          className="flex-1 truncate pt-1.5 font-mono text-xs text-[rgba(255,255,255,0.6)]"
          title={String(value)}
        >
          {JSON.stringify(value)}
        </span>
      )}
    </div>
  );
}

// ─── ActionCard ───────────────────────────────────────────────────────────────

export function ActionCard({
  cardId,
  command,
  args,
  alwaysAsk = false,
  onDecision,
}: ActionCardProps) {
  /** Local mutable copy of args for editing. */
  const [localArgs, setLocalArgs] = useState<Record<string, unknown>>(() => ({ ...args }));
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [showRespond, setShowRespond] = useState(false);

  const handleArgChange = useCallback((key: string, value: string) => {
    setLocalArgs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleApprove = useCallback(() => {
    const changed = !argsEqual(localArgs, args);
    if (changed) {
      onDecision({ card_id: cardId, decision: 'edit', args: localArgs });
    } else {
      onDecision({ card_id: cardId, decision: 'approve', always_allow: alwaysAllow });
    }
  }, [cardId, localArgs, args, alwaysAllow, onDecision]);

  const handleReject = useCallback(() => {
    onDecision({ card_id: cardId, decision: 'reject' });
  }, [cardId, onDecision]);

  const handleRespondDecision = useCallback(
    (d: ActionCardDecision) => {
      onDecision(d);
      setShowRespond(false);
    },
    [onDecision],
  );

  const argEntries = Object.entries(localArgs);

  return (
    <div
      className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)]"
      data-testid="action-card"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.35)]">
          Action
        </p>
        <code className="rounded bg-[rgba(255,255,255,0.06)] px-2 py-0.5 font-mono text-sm text-foreground">
          {command}
        </code>
        {alwaysAsk && (
          <span className="ml-auto rounded bg-[#EF4444]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#EF4444]">
            destructive
          </span>
        )}
      </div>

      {/* Args */}
      {argEntries.length > 0 && (
        <div className="space-y-2 px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.25)]">
            Arguments
          </p>
          {argEntries.map(([k, v]) => (
            <ArgField key={k} argKey={k} value={v} onChange={handleArgChange} />
          ))}
        </div>
      )}

      {/* Respond panel */}
      {showRespond && (
        <div className="border-t border-[rgba(255,255,255,0.08)] px-4 py-3">
          <RespondPanel
            cardId={cardId}
            onDecision={handleRespondDecision}
            onCancel={() => setShowRespond(false)}
          />
        </div>
      )}

      {/* Footer: always-allow toggle + action buttons */}
      <div className="flex flex-wrap items-center gap-3 border-t border-[rgba(255,255,255,0.08)] px-4 py-3">
        {/* Always-allow toggle (hidden for destructive tier) */}
        {!alwaysAsk && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[rgba(255,255,255,0.45)]">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
              aria-label="Always allow this command"
              className="h-3.5 w-3.5 cursor-pointer accent-[#3B82F6]"
            />
            Always allow this
          </label>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Respond */}
          {!showRespond && (
            <button
              type="button"
              onClick={() => setShowRespond(true)}
              aria-label="Respond with a follow-up message"
              className={cn(
                'rounded-lg border border-[rgba(255,255,255,0.1)] px-3 py-1.5 text-sm',
                'text-[rgba(255,255,255,0.55)] hover:border-[rgba(255,255,255,0.2)] hover:text-white',
                FOCUS_RING,
              )}
            >
              Respond
            </button>
          )}

          {/* Reject */}
          <button
            type="button"
            onClick={handleReject}
            aria-label="Reject this action"
            className={cn(
              'rounded-lg border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-sm',
              'text-[rgba(255,255,255,0.65)] hover:border-[#EF4444]/50 hover:text-[#EF4444]',
              FOCUS_RING,
            )}
          >
            Reject
          </button>

          {/* Approve */}
          <button
            type="button"
            onClick={handleApprove}
            aria-label="Approve this action"
            className={cn(
              'rounded-lg bg-[#3B82F6] px-3 py-1.5 text-sm font-medium text-white',
              'hover:opacity-90',
              FOCUS_RING,
            )}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
