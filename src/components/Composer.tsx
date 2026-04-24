import {
  useReducer,
  useEffect,
  useState,
  useCallback,
  useRef,
  forwardRef,
  type KeyboardEvent,
  type FormEvent,
  type Ref,
} from 'react';
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
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { api } from '@/lib/api';
import { useTasksContext } from '@/lib/tasks-context';
import type { Task, Agent } from '../../server/types';

/** POST /api/chats — create a standalone runtime agent. */
async function createChatRequest(body: { label?: string }): Promise<Agent> {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /api/chats: ${res.status}`);
  return (await res.json()) as Agent;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function repoBasename(path: string): string {
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || path;
}

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

  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{
    message: string;
    conflictTaskId?: string | null;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const repoChipRef = useRef<HTMLButtonElement>(null);
  const branchChipRef = useRef<HTMLButtonElement>(null);
  const worktreeCheckboxRef = useRef<HTMLButtonElement>(null);

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

  const onClearIntent = useCallback(() => dispatch({ type: 'clearIntent' }), []);

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
        if (state.mode === 'add-agent') {
          await api.addAgent(state.sessionId, { prompt: trimmed });
          refresh();
          navigate(`/tasks/${state.sessionId}`);
        } else if (state.mode === 'scratch') {
          const chat = await createChatRequest({ label: deriveTitleFromPrompt(trimmed) });
          navigate(`/chats/${chat.id}`);
        } else if (state.mode !== 'empty') {
          const title = deriveTitleFromPrompt(trimmed);
          const payload: Parameters<typeof api.createTask>[0] = {
            title,
            description: trimmed,
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
          const created = await api.createTask(payload);
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
    [canSubmit, prompt, state, navigate, onSubmitted, refresh],
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

  // Global shortcut bridges (⌘⇧N → focus, ⌘Enter → submit) + local shortcuts
  // (⌘R → repo, ⌘B → branch, ⌘W → toggle worktree).
  const submitRef = useRef(handleSubmit);
  submitRef.current = handleSubmit;
  const toggleWorktreeRef = useRef(onToggleWorktree);
  toggleWorktreeRef.current = onToggleWorktree;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ prefill?: string } | undefined>).detail;
      if (detail?.prefill) {
        setPrompt((prev) => (prev ? prev : detail.prefill!));
      }
      textareaRef.current?.focus();
    };
    const onSubmit = () => {
      void submitRef.current();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'r') {
        e.preventDefault();
        repoChipRef.current?.click();
      } else if (key === 'b') {
        e.preventDefault();
        branchChipRef.current?.click();
      } else if (key === 'w') {
        const s = stateRef.current;
        if (s.mode === 'new') {
          e.preventDefault();
          toggleWorktreeRef.current(false);
        } else if (s.mode === 'none') {
          e.preventDefault();
          toggleWorktreeRef.current(true);
        }
      }
    };
    window.addEventListener('focus-composer', onFocus);
    window.addEventListener('submit-composer', onSubmit);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('focus-composer', onFocus);
      window.removeEventListener('submit-composer', onSubmit);
      window.removeEventListener('keydown', onKey);
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

  return (
    <GlassPanel
      level={3}
      specular
      className="flex flex-col gap-2 rounded-[20px] px-4 py-3"
      data-testid="composer"
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
          <RepoChip ref={repoChipRef} value="" onChange={onPickRepo} onClear={onClearRepo} />
        ) : (
          <RepoChip
            ref={repoChipRef}
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
            ref={branchChipRef}
            repoPath={state.mode === 'new' || state.mode === 'none' ? state.repo : ''}
            value={state.branch ?? ''}
            onChange={onPickBranch}
          />
        )}

        {showWorktreeCheckbox && (
          <WorktreeCheckbox
            ref={worktreeCheckboxRef}
            checked={worktreeOn}
            onChange={onToggleWorktree}
          />
        )}

        {showAttachChip && (
          <AttachChip
            value={state.mode === 'existing' ? state.worktreePath : ''}
            onChange={onSetExistingPath}
            onClear={onClearExistingPath}
          />
        )}

        <DraftToggle
          checked={'isDraft' in state ? state.isDraft : false}
          onChange={onToggleDraft}
          disabled={state.mode === 'empty' || state.mode === 'add-agent'}
        />

        {showScratchHint && (
          <span
            className="ml-auto select-none rounded border border-border/60 bg-muted/20 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
            data-testid="scratch-hint"
            title="No repo selected — submission creates a scratch chat."
          >
            <span className="mr-1 text-[9px] opacity-60">S</span>scratch
          </span>
        )}
      </div>

      {/* Prompt + submit. Textarea stays opaque (terminal rule). */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          data-testid="composer-prompt"
          className="min-h-[72px] resize-y rounded-2xl border border-white/10 px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-ring"
          style={{ backgroundColor: '#0B0C0F' }}
          placeholder={promptPlaceholder(state)}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onTextareaKeyDown}
          aria-label="Task prompt"
        />
        <div className="flex items-center justify-end gap-2">
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
            style={{ boxShadow: canSubmit ? '0 0 12px rgba(34,211,238,0.45)' : undefined }}
          >
            {submitting ? 'Starting…' : 'Start task'}
          </Button>
        </div>
      </form>
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
      return 'Scratch session';
    case 'new':
      if (state.forkOf) {
        return `Forking from ${sourceTask?.title ?? state.forkOf}`;
      }
      return `New task in ${repoBasename(state.repo)}`;
    case 'none':
      return `In-place in ${repoBasename(state.repo)}`;
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
const RepoChip = forwardRef<HTMLButtonElement, RepoChipProps>(function RepoChip(
  { value, onChange, onClear },
  ref,
) {
  const [expanded, setExpanded] = useState(false);
  if (!value && !expanded) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={() => setExpanded(true)}
        data-testid="repo-chip-picker"
        className="inline-flex items-center gap-1 rounded border border-dashed border-border/80 px-3 py-1 text-[11px] font-mono text-muted-foreground hover:border-foreground hover:text-foreground"
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
    <ChipRemovable
      buttonRef={ref}
      label={`📁 ${repoBasename(value)}`}
      title={value}
      onRemove={onClear}
      data-testid="repo-chip"
    />
  );
});

interface BranchChipProps {
  repoPath: string;
  value: string;
  onChange: (branch: string) => void;
}

const BranchChip = forwardRef<HTMLButtonElement, BranchChipProps>(function BranchChip(
  { repoPath, value, onChange },
  ref,
) {
  return (
    <div className="flex items-center gap-1" data-testid="branch-chip">
      <span className="text-xs text-muted-foreground" aria-hidden>
        ⎇
      </span>
      <div className="min-w-[140px] max-w-[220px]">
        <BranchPickerField triggerRef={ref} repoPath={repoPath} value={value} onChange={onChange} />
      </div>
    </div>
  );
});

interface WorktreeCheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
}

/**
 * Worktree checkbox pill. Off = task runs on the branch's working tree
 * (`run_mode: 'none'`). On = fresh worktree (`run_mode: 'new'`). When on, the
 * pill fills cyan with a white checkmark.
 */
const WorktreeCheckbox = forwardRef<HTMLButtonElement, WorktreeCheckboxProps>(
  function WorktreeCheckbox({ checked, onChange }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label="Create a fresh worktree for this task"
        onClick={() => onChange(!checked)}
        data-testid="worktree-checkbox"
        data-state={checked ? 'checked' : 'unchecked'}
        className="inline-flex items-center gap-2 rounded border px-2 py-1 text-[11px] font-mono transition-colors"
        style={{
          borderColor: checked ? 'rgba(59,130,246,0.4)' : 'var(--border)',
          backgroundColor: checked ? 'rgba(59,130,246,0.12)' : 'transparent',
          color: checked ? 'rgb(147,197,253)' : 'var(--muted-foreground)',
        }}
      >
        <span
          aria-hidden
          className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-sm border"
          style={{
            borderColor: checked ? 'rgba(59,130,246,0.6)' : 'var(--border)',
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
        <span>worktree</span>
      </button>
    );
  },
);

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
        🔗 attach
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
      className={`px-2 py-1 border text-[11px] font-mono ${
        checked
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground'
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
      className="inline-flex items-center gap-1 border border-border px-2 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/40"
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
  buttonRef,
  ...rest
}: {
  label: string;
  title?: string;
  onRemove: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      title={title}
      className="inline-flex items-center gap-1 border border-border px-2 py-1 text-[11px] font-mono"
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="inline-flex items-center gap-1 text-foreground hover:text-muted-foreground"
      >
        <span>{label}</span>
        <span className="text-muted-foreground">×</span>
      </button>
    </div>
  );
}
