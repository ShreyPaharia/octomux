import {
  useReducer,
  useEffect,
  useState,
  useCallback,
  useRef,
  type KeyboardEvent,
  type FormEvent,
} from 'react';
import { repoBasename } from '@/lib/utils';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  reduce,
  hydrateFromUrl,
  stateToUrlParams,
  validateForSubmit,
  type ComposerState,
} from '@/lib/composer-state';
import { RepoPickerField } from './fields/RepoPickerField';
import { BranchPickerField } from './fields/BranchPickerField';
import { AgentPickerField } from './fields/AgentPickerField';
import { HarnessPicker } from './HarnessPicker';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { api } from '@/lib/api';
import type { PreflightResult } from '@/lib/api';
import { useTasksContext } from '@/lib/tasks-context';
import type { Task, Agent } from '../../server/types';
import { NoneModeConflictDialog } from './NoneModeConflictDialog';
import { NoneModeDirtyDialog } from './NoneModeDirtyDialog';
import { NoneModeSharedBranchDialog } from './NoneModeSharedBranchDialog';

/** POST /api/chats — create a standalone runtime agent. */
async function createChatRequest(body: {
  label?: string;
  agent?: string | null;
  prompt?: string;
  harness_id?: string;
}): Promise<Agent> {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /api/chats: ${res.status}`);
  return (await res.json()) as Agent;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const DRAFT_KEY = 'octomux-composer-draft-prompt';

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0] ?? '';
  return firstLine.slice(0, 80) || 'Untitled task';
}

interface Props {
  /** Called on successful submission so the parent can refresh task lists. */
  onSubmitted?: (task: Task) => void;
}

// ─── Main component ──────────────────────────────────────────────────────

export function Composer({ onSubmitted }: Props = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { tasks, refresh } = useTasksContext();

  const [state, dispatch] = useReducer(reduce, searchParams, (params: URLSearchParams) =>
    hydrateFromUrl(params),
  );

  const [prompt, setPrompt] = useState<string>(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [harnessId, setHarnessId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preflightBlock, setPreflightBlock] = useState<{
    result: PreflightResult;
    payload: Parameters<typeof api.createTask>[0];
  } | null>(null);
  const [errorBanner, setErrorBanner] = useState<{
    message: string;
    conflictTaskId?: string | null;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Persist prompt draft to localStorage (debounced 250 ms).
  useEffect(() => {
    const timer = setTimeout(() => {
      if (prompt) {
        localStorage.setItem(DRAFT_KEY, prompt);
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [prompt]);

  // Re-hydrate when the URL is changed externally.
  const lastHydratedRef = useRef(searchParams.toString());
  useEffect(() => {
    const current = searchParams.toString();
    if (current === lastHydratedRef.current) return;
    lastHydratedRef.current = current;
    dispatch({ type: 'hydrateFromUrl', params: searchParams });
    setErrorBanner(null);
  }, [searchParams]);

  // Mirror chip state → URL.
  useEffect(() => {
    const next = stateToUrlParams(state).toString();
    if (next === searchParams.toString()) return;
    lastHydratedRef.current = next;
    setSearchParams(next ? new URLSearchParams(next) : new URLSearchParams(), { replace: true });
  }, [state, searchParams, setSearchParams]);

  const addAgentSourceId = state.mode === 'add-agent' ? state.sessionId : null;
  const forkOfId = state.mode === 'new' && state.forkOf ? state.forkOf : null;
  const sourceTaskId = addAgentSourceId ?? forkOfId ?? null;
  const sourceTask = sourceTaskId ? (tasks.find((t) => t.id === sourceTaskId) ?? null) : null;
  const sourceTaskMissing = sourceTaskId !== null && !sourceTask && tasks.length > 0;

  // ─── Dispatchers ─────────────────────────────────────────────────────

  const onPickRepo = useCallback(async (repoPath: string) => {
    if (!repoPath) {
      dispatch({ type: 'clearRepo' });
      return;
    }
    let defaultBranch: string | null = null;
    try {
      const res = await api.getDefaultBranch(repoPath);
      defaultBranch = res.branch;
    } catch {
      defaultBranch = null;
    }
    dispatch({ type: 'pickRepo', repo: repoPath, defaultBranch });
  }, []);

  const onClearRepo = useCallback(() => dispatch({ type: 'clearRepo' }), []);

  const onPickBranch = useCallback(
    (branch: string) => dispatch({ type: 'pickBranch', branch }),
    [],
  );

  const onToggleWorktree = useCallback(
    (worktree: boolean) => dispatch({ type: 'toggleWorktree', worktree }),
    [],
  );

  const onSetExistingPath = useCallback(
    (path: string) => dispatch({ type: 'setExistingPath', path }),
    [],
  );

  const onClearExistingPath = useCallback(() => dispatch({ type: 'clearExistingPath' }), []);

  const onToggleDraft = useCallback(() => dispatch({ type: 'toggleDraft' }), []);

  const onPickAgent = useCallback(
    (agent: string | null) => dispatch({ type: 'pickAgent', agent }),
    [],
  );

  const onClearIntent = useCallback(() => {
    dispatch({ type: 'clearIntent' });
    localStorage.removeItem(DRAFT_KEY);
    setPrompt('');
  }, []);

  // ─── Submit ──────────────────────────────────────────────────────────

  const blockedReason = validateForSubmit(state, prompt);
  const canSubmit = !blockedReason && !submitting && !sourceTaskMissing;

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setErrorBanner(null);
      try {
        const trimmed = prompt.trim();
        const pickedAgent = 'agent' in state ? (state.agent ?? null) : null;
        if (state.mode === 'add-agent') {
          await api.addAgent(state.sessionId, {
            prompt: trimmed,
            ...(pickedAgent ? { agent: pickedAgent } : {}),
          });
          localStorage.removeItem(DRAFT_KEY);
          setPrompt('');
          refresh();
          navigate(`/tasks/${state.sessionId}`);
        } else if (state.mode === 'scratch') {
          const chat = await createChatRequest({
            label: deriveTitleFromPrompt(trimmed),
            agent: pickedAgent,
            prompt: trimmed,
            ...(harnessId ? { harness_id: harnessId } : {}),
          });
          localStorage.removeItem(DRAFT_KEY);
          setPrompt('');
          refresh();
          navigate(`/chats/${chat.id}`);
        } else if (state.mode !== 'empty') {
          // Title pre-filled from prompt for fast CREATE (no Claude CLI round-trip).
          // Description omitted so the API stores the full initial_prompt body.
          const payload: Parameters<typeof api.createTask>[0] = {
            title: deriveTitleFromPrompt(trimmed),
            initial_prompt: trimmed,
          };
          if (state.mode === 'new') {
            payload.run_mode = 'new';
            payload.repo_path = state.repo;
            if (state.branch) payload.base_branch = state.branch;
          } else if (state.mode === 'none') {
            payload.run_mode = 'none';
            payload.repo_path = state.repo;
            if (state.branch) payload.base_branch = state.branch;
          } else if (state.mode === 'existing') {
            payload.run_mode = 'existing';
            payload.repo_path = state.repo;
            payload.worktree_path = state.worktreePath;
          }
          if ('isDraft' in state && state.isDraft) payload.draft = true;
          if (pickedAgent) payload.agent = pickedAgent;
          if (harnessId) payload.harness_id = harnessId;

          // Preflight only for none-mode + base_branch
          if (state.mode === 'none' && state.branch) {
            const pre = await api.preflightNoneMode(state.repo, state.branch);
            // Conflicts (different-branch active task) and dirty both block
            // creation. Same-branch warnings don't block but require an
            // explicit confirmation.
            if (!pre.ok || pre.warnings.length > 0) {
              setPreflightBlock({ result: pre, payload });
              return;
            }
          }

          const created = await api.createTask(payload);
          localStorage.removeItem(DRAFT_KEY);
          setPrompt('');
          refresh();
          onSubmitted?.(created);
          navigate(`/tasks/${created.id}`);
        }
      } catch (err) {
        const message = (err as Error).message || 'Submission failed';
        const conflictMatch = /task\s+([a-zA-Z0-9_-]{6,})/i.exec(message);
        setErrorBanner({
          message,
          conflictTaskId: conflictMatch ? conflictMatch[1] : null,
        });
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, prompt, state, navigate, onSubmitted, refresh, harnessId],
  );

  const onTextareaKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Auto-focus on mount.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ prefill?: string } | undefined>).detail;
      if (detail?.prefill) {
        setPrompt((prev) => (prev ? prev : detail.prefill!));
      }
      textareaRef.current?.focus();
    };
    window.addEventListener('focus-composer', onFocus);
    return () => {
      window.removeEventListener('focus-composer', onFocus);
    };
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────

  const hasRepo = state.mode === 'new' || state.mode === 'none' || state.mode === 'existing';
  const worktreeOn = state.mode === 'new';
  const showBranchChip = state.mode === 'new' || state.mode === 'none';
  const showWorktreeCheckbox = state.mode === 'new' || state.mode === 'none';
  const showAttachChip = state.mode === 'new' || state.mode === 'existing' || state.mode === 'none';
  const disabledByAddAgent = state.mode === 'add-agent';
  const showScratchHint = !hasRepo && state.mode !== 'add-agent';
  const pickedAgent = 'agent' in state ? (state.agent ?? null) : null;
  const showAgentChip = state.mode !== 'empty';

  return (
    <GlassPanel
      level={3}
      className="flex flex-col gap-2 rounded-[20px] px-4 py-3"
      data-testid="composer"
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.078)',
        borderColor: 'rgba(255, 255, 255, 0.15)',
        boxShadow:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.25), 0 24px 60px -12px rgba(0, 0, 0, 0.56)',
      }}
    >
      <IntentHeader
        state={state}
        sourceTask={sourceTask}
        sourceTaskMissing={sourceTaskMissing}
        onClear={onClearIntent}
      />

      {errorBanner && (
        <div
          role="alert"
          data-testid="composer-error"
          className="flex items-center justify-between border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>{errorBanner.message}</span>
          {errorBanner.conflictTaskId && (
            <Link
              to={`/tasks/${errorBanner.conflictTaskId}`}
              className="ml-3 underline hover:no-underline"
            >
              View conflicting task →
            </Link>
          )}
        </div>
      )}

      {/* Chip row — derives run_mode from (repo ∧ worktree). */}
      <div
        className={`flex flex-wrap items-center gap-2 ${disabledByAddAgent ? 'pointer-events-none opacity-40' : ''}`}
        data-testid="chip-row"
      >
        {!hasRepo ? (
          <RepoChip value="" onChange={onPickRepo} onClear={onClearRepo} />
        ) : (
          <RepoChip
            value={
              state.mode === 'new' || state.mode === 'none' || state.mode === 'existing'
                ? state.repo
                : ''
            }
            onChange={onPickRepo}
            onClear={onClearRepo}
          />
        )}

        {showBranchChip && (
          <BranchChip
            repoPath={state.mode === 'new' || state.mode === 'none' ? state.repo : ''}
            value={state.branch ?? ''}
            onChange={onPickBranch}
          />
        )}

        {showWorktreeCheckbox && (
          <WorktreeCheckbox checked={worktreeOn} onChange={onToggleWorktree} />
        )}

        {showAttachChip && (
          <AttachChip
            value={state.mode === 'existing' ? state.worktreePath : ''}
            onChange={onSetExistingPath}
            onClear={onClearExistingPath}
          />
        )}

        {showAgentChip && <AgentChip value={pickedAgent} onChange={onPickAgent} />}

        {state.mode !== 'add-agent' && <HarnessChip value={harnessId} onChange={setHarnessId} />}

        <DraftToggle
          checked={'isDraft' in state ? state.isDraft : false}
          onChange={onToggleDraft}
          disabled={state.mode === 'empty' || state.mode === 'add-agent'}
        />

        {showScratchHint && (
          <span
            className="ml-auto inline-flex select-none items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
            data-testid="scratch-hint"
            title="No repo selected — submission creates a scratch chat."
          >
            <span className="text-[9px] font-bold opacity-70">S</span>
            <span>scratch</span>
          </span>
        )}
      </div>

      {/* Prompt + submit — opaque block (terminal rule). */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-2xl border border-white/10 p-3"
        style={{ backgroundColor: '#0B0C0F' }}
      >
        <textarea
          ref={textareaRef}
          data-testid="composer-prompt"
          className="focus-ring min-h-[72px] resize-y rounded-lg bg-transparent px-1 py-1 text-sm font-mono text-foreground outline-none"
          placeholder={promptPlaceholder(state)}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onTextareaKeyDown}
          aria-label="Task prompt"
        />
        <div className="flex items-center gap-3">
          <span className="flex-1" />
          {blockedReason && prompt.trim() && (
            <span className="text-[11px] text-muted-foreground" title={blockedReason}>
              {blockedReason}
            </span>
          )}
          <Button
            type="submit"
            disabled={!canSubmit}
            data-testid="composer-submit"
            title={blockedReason ?? undefined}
            className="bg-cyan-500 text-white hover:bg-cyan-400"
            style={{ boxShadow: canSubmit ? '0 0 20px rgba(59,130,246,0.45)' : undefined }}
          >
            {submitting ? 'Starting…' : 'Start task'}
          </Button>
        </div>
      </form>
      {preflightBlock && preflightBlock.result.conflicts.length > 0 && (
        <NoneModeConflictDialog
          open
          conflicts={preflightBlock.result.conflicts}
          targetBranch={preflightBlock.result.targetBranch}
          onClose={() => setPreflightBlock(null)}
          onCloseTask={async (taskId) => {
            await api.updateTask(taskId, { status: 'closed' });
            const repoForPreflight = preflightBlock.payload.repo_path!;
            const branchForPreflight = preflightBlock.payload.base_branch!;
            const next = await api.preflightNoneMode(repoForPreflight, branchForPreflight);
            setPreflightBlock({ result: next, payload: preflightBlock.payload });
          }}
          onResolved={async () => {
            // Hand off to the dirty / shared-branch dialogs if those checks
            // now apply — their conditional renders will pick up the flow.
            if (preflightBlock.result.dirty) return;
            if (preflightBlock.result.warnings.length > 0) return;
            const created = await api.createTask(preflightBlock.payload);
            setPreflightBlock(null);
            refresh();
            onSubmitted?.(created);
            navigate(`/tasks/${created.id}`);
          }}
        />
      )}
      {preflightBlock &&
        preflightBlock.result.conflicts.length === 0 &&
        preflightBlock.result.dirty && (
          <NoneModeDirtyDialog
            open
            count={preflightBlock.result.dirty.count}
            currentBranch={preflightBlock.result.currentBranch}
            targetBranch={preflightBlock.result.targetBranch}
            onClose={() => setPreflightBlock(null)}
            onStash={async () => {
              await api.stashRepo(
                preflightBlock.payload.repo_path!,
                preflightBlock.payload.base_branch!,
              );
              const created = await api.createTask(preflightBlock.payload);
              setPreflightBlock(null);
              refresh();
              onSubmitted?.(created);
              navigate(`/tasks/${created.id}`);
            }}
          />
        )}
      {preflightBlock &&
        preflightBlock.result.conflicts.length === 0 &&
        !preflightBlock.result.dirty &&
        preflightBlock.result.warnings.length > 0 && (
          <NoneModeSharedBranchDialog
            open
            warnings={preflightBlock.result.warnings}
            targetBranch={preflightBlock.result.targetBranch}
            onClose={() => setPreflightBlock(null)}
            onConfirm={async () => {
              const created = await api.createTask(preflightBlock.payload);
              setPreflightBlock(null);
              refresh();
              onSubmitted?.(created);
              navigate(`/tasks/${created.id}`);
            }}
          />
        )}
    </GlassPanel>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function IntentHeader({
  state,
  sourceTask,
  sourceTaskMissing,
  onClear,
}: {
  state: ComposerState;
  sourceTask: Task | null;
  sourceTaskMissing: boolean;
  onClear: () => void;
}) {
  const text = intentHeaderText(state, sourceTask, sourceTaskMissing);
  if (!text) return null;
  const isError = sourceTaskMissing;
  return (
    <div
      data-testid="intent-header"
      className={`flex items-center justify-between border px-3 py-1.5 text-xs ${
        isError
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-border bg-muted/40 text-muted-foreground'
      }`}
    >
      <span>{text}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Dismiss intent"
        className="ml-3 text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

function intentHeaderText(
  state: ComposerState,
  sourceTask: Task | null,
  sourceTaskMissing: boolean,
): string | null {
  if (sourceTaskMissing) return 'Source task not found';
  switch (state.mode) {
    case 'empty':
      return null;
    case 'scratch':
      return null;
    case 'new':
      if (state.forkOf) {
        return `Forking from ${sourceTask?.title ?? state.forkOf}`;
      }
      return null;
    case 'none':
      return null;
    case 'existing':
      return `Attaching existing ${repoBasename(state.worktreePath)}`;
    case 'add-agent':
      return `Adding agent to ${sourceTask?.title ?? state.sessionId}`;
  }
}

function promptPlaceholder(state: ComposerState): string {
  if (state.mode === 'add-agent') return 'Instructions for the new agent…';
  if (state.mode === 'empty') return 'Describe a task or ask a question…';
  return 'Describe what you want the agent to do…';
}

// ─── Chip primitives ─────────────────────────────────────────────────────

interface RepoChipProps {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}

/**
 * Empty state: a dashed-border chip `+ Add repo or folder`.
 * Filled state: a pill showing the repo basename with a remove button.
 */
function RepoChip({ value, onChange, onClear }: RepoChipProps) {
  const [expanded, setExpanded] = useState(false);
  if (!value && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        data-testid="repo-chip-picker"
        className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-dashed border-white/20 bg-white/[0.03] px-3 py-1 text-[11px] font-mono text-muted-foreground hover:border-foreground hover:text-foreground"
      >
        <span aria-hidden>+</span>
        <span>Add repo or folder</span>
      </button>
    );
  }
  if (!value && expanded) {
    return (
      <div className="flex items-center gap-2" data-testid="repo-chip-expanded">
        <div className="w-[320px]">
          <RepoPickerField value="" onChange={onChange} />
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-xs text-muted-foreground"
        >
          cancel
        </button>
      </div>
    );
  }
  return (
    <div
      data-testid="repo-chip"
      title={value}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-mono"
      style={{
        backgroundColor: 'rgba(59, 130, 246, 0.12)',
        borderColor: 'rgba(59, 130, 246, 0.4)',
        color: '#3B82F6',
      }}
    >
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove"
        className="inline-flex items-center gap-1.5 font-semibold hover:opacity-80"
        style={{ color: '#3B82F6' }}
      >
        <span aria-hidden>📁</span>
        <span>{repoBasename(value)}</span>
        <span aria-hidden style={{ color: 'rgba(59, 130, 246, 0.7)' }}>
          ×
        </span>
      </button>
    </div>
  );
}

interface BranchChipProps {
  repoPath: string;
  value: string;
  onChange: (branch: string) => void;
}

function BranchChip({ repoPath, value, onChange }: BranchChipProps) {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.15] bg-white/[0.06] px-3 py-[3px] text-[11px] font-mono"
      data-testid="branch-chip"
    >
      <span className="text-[11px] text-muted-foreground" aria-hidden>
        ⎇
      </span>
      <div className="min-w-[100px] max-w-[220px]">
        <BranchPickerField
          repoPath={repoPath}
          value={value}
          onChange={onChange}
          triggerClassName="focus-ring flex w-full items-center justify-between gap-1.5 bg-transparent font-mono text-[11px] text-[#D0D0D0] outline-none hover:text-white disabled:opacity-60"
        />
      </div>
    </div>
  );
}

interface WorktreeCheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
}

/**
 * Worktree checkbox pill. Off = task runs on the branch's working tree
 * (`run_mode: 'none'`). On = fresh worktree (`run_mode: 'new'`). When on, the
 * pill fills cyan with a white checkmark.
 */
function WorktreeCheckbox({ checked, onChange }: WorktreeCheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label="Create a fresh worktree for this task"
      onClick={() => onChange(!checked)}
      data-testid="worktree-checkbox"
      data-state={checked ? 'checked' : 'unchecked'}
      className="focus-ring inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] font-mono transition-colors"
      style={{
        borderColor: checked ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.18)',
        backgroundColor: checked ? 'rgba(59,130,246,0.12)' : 'transparent',
        color: checked ? '#3B82F6' : 'var(--muted-foreground)',
        fontWeight: checked ? 600 : 500,
      }}
    >
      <span
        aria-hidden
        className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-sm border"
        style={{
          borderColor: checked ? 'rgba(59,130,246,0.6)' : 'rgba(255,255,255,0.22)',
          backgroundColor: checked ? 'rgb(59,130,246)' : 'transparent',
        }}
      >
        {checked && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <span>new worktree</span>
    </button>
  );
}

function AttachChip({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (path: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [typed, setTyped] = useState('');

  if (!value && !expanded) {
    return (
      <ChipButton onClick={() => setExpanded(true)} data-testid="attach-chip-picker">
        <span aria-hidden>🔗</span>
        <span>attach</span>
      </ChipButton>
    );
  }
  if (!value && expanded) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) {
            onChange(typed.trim());
            setExpanded(false);
            setTyped('');
          }
        }}
        className="flex items-center gap-1"
        data-testid="attach-chip-expanded"
      >
        <span className="text-xs text-muted-foreground">🔗</span>
        <input
          autoFocus
          placeholder="/path/to/existing/worktree"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => {
            if (typed.trim()) onChange(typed.trim());
            setExpanded(false);
          }}
          className="h-7 w-[280px] border border-input bg-transparent px-2 text-xs font-mono outline-none focus:border-ring"
          aria-label="Existing worktree path"
        />
      </form>
    );
  }
  return (
    <ChipRemovable
      label={`🔗 ${repoBasename(value)}`}
      title={value}
      onRemove={onClear}
      data-testid="attach-chip"
    />
  );
}

interface AgentChipProps {
  value: string | null;
  onChange: (agent: string | null) => void;
}

/**
 * Empty state: dashed pill `+ run as agent` (matches RepoChip).
 * Filled state: amber pill `🤖 <name> ×` (×) clears, click reopens picker.
 */
function AgentChip({ value, onChange }: AgentChipProps) {
  if (!value) {
    return (
      <div data-testid="agent-chip-empty">
        <AgentPickerField
          value={null}
          onChange={onChange}
          triggerLabel="+ run as agent"
          triggerClassName="focus-ring inline-flex items-center gap-1.5 rounded-full border border-dashed border-white/20 bg-white/[0.03] px-3 py-1 text-[11px] font-mono text-muted-foreground hover:border-foreground hover:text-foreground"
        />
      </div>
    );
  }
  return (
    <div
      data-testid="agent-chip"
      title={value}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-mono"
      style={{
        backgroundColor: 'rgba(245, 158, 11, 0.12)',
        borderColor: 'rgba(245, 158, 11, 0.4)',
        color: '#F59E0B',
      }}
    >
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="Clear agent"
        className="inline-flex items-center gap-1.5 font-semibold hover:opacity-80"
        style={{ color: '#F59E0B' }}
      >
        <span aria-hidden>🤖</span>
        <span>{value}</span>
        <span aria-hidden style={{ color: 'rgba(245, 158, 11, 0.7)' }}>
          ×
        </span>
      </button>
    </div>
  );
}

interface HarnessChipProps {
  value: string | null;
  onChange: (id: string) => void;
}

/** Compact chip showing the selected coding agent (harness). */
function HarnessChip({ value, onChange }: HarnessChipProps) {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.15] bg-white/[0.06] px-3 py-[3px] text-[11px] font-mono"
      data-testid="harness-chip"
      title="Coding agent"
    >
      <span aria-hidden className="text-[11px] text-muted-foreground">
        ⚙
      </span>
      <div className="min-w-[80px] max-w-[160px]">
        <HarnessPicker
          value={value}
          onChange={onChange}
          triggerClassName="focus-ring flex w-full items-center justify-between gap-1.5 bg-transparent font-mono text-[11px] text-[#D0D0D0] outline-none hover:text-white disabled:opacity-60"
        />
      </div>
    </div>
  );
}

function DraftToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      aria-pressed={checked}
      data-testid="draft-toggle"
      className={`focus-ring rounded-full border px-3 py-1 text-[11px] font-mono transition-colors disabled:opacity-40 ${
        checked
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-white/[0.15] bg-white/[0.03] text-muted-foreground hover:text-foreground'
      }`}
    >
      📝 draft
    </button>
  );
}

// ─── Chip atoms ──────────────────────────────────────────────────────────

function ChipButton({ children, onClick, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/[0.15] bg-white/[0.03] px-3 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-white/[0.08]"
      {...rest}
    >
      {children}
    </button>
  );
}

function ChipRemovable({
  label,
  title,
  onRemove,
  ...rest
}: {
  label: string;
  title?: string;
  onRemove: () => void;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      title={title}
      className="inline-flex items-center gap-1 rounded-full border border-white/[0.15] bg-white/[0.06] px-3 py-1 text-[11px] font-mono"
    >
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="focus-ring inline-flex items-center gap-1.5 text-foreground hover:text-muted-foreground"
      >
        <span>{label}</span>
        <span className="text-muted-foreground">×</span>
      </button>
    </div>
  );
}
