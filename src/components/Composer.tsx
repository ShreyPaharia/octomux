import {
  useReducer,
  useEffect,
  useState,
  useCallback,
  useRef,
  type KeyboardEvent,
  type FormEvent,
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

  // Initial state is derived from the URL exactly once on mount.
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

  // Re-hydrate when the URL is changed externally (e.g. sidebar click navigating
  // to a new `?repo=...` URL while the Composer is already mounted).
  const lastHydratedRef = useRef(searchParams.toString());
  useEffect(() => {
    const current = searchParams.toString();
    if (current === lastHydratedRef.current) return;
    lastHydratedRef.current = current;
    dispatch({ type: 'hydrateFromUrl', params: searchParams });
    setErrorBanner(null);
  }, [searchParams]);

  // Mirror chip state → URL. Skip when nothing would change to avoid dirty loops.
  useEffect(() => {
    const next = stateToUrlParams(state).toString();
    if (next === searchParams.toString()) return;
    lastHydratedRef.current = next;
    setSearchParams(next ? new URLSearchParams(next) : new URLSearchParams(), { replace: true });
  }, [state, searchParams, setSearchParams]);

  // Source task lookup for add-agent + fork intent headers.
  const addAgentSourceId = state.mode === 'add-agent' ? state.sessionId : null;
  const forkOfId = state.mode === 'new' && state.forkOf ? state.forkOf : null;
  const sourceTaskId = addAgentSourceId ?? forkOfId ?? null;
  const sourceTask = sourceTaskId ? (tasks.find((t) => t.id === sourceTaskId) ?? null) : null;
  const sourceTaskMissing = sourceTaskId !== null && !sourceTask && tasks.length > 0;

  // ─── Chip dispatchers ────────────────────────────────────────────────

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
          // Phase 2a: scratch submit creates a standalone runtime agent (chat),
          // not a scratch task. The prompt is not forwarded today — the Claude
          // session starts fresh in the chat terminal.
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
        // Try to correlate server conflict messages to an existing task for an inline link.
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

  // Auto-focus on mount so the composer is immediately typeable — also gives
  // ⌘⇧N (navigate to /) a predictable focus target on remount.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Listen for global shortcut bridges (⌘⇧N → focus, ⌘Enter → submit).
  const submitRef = useRef(handleSubmit);
  submitRef.current = handleSubmit;
  useEffect(() => {
    const onFocus = () => textareaRef.current?.focus();
    const onSubmit = () => {
      void submitRef.current();
    };
    window.addEventListener('focus-composer', onFocus);
    window.addEventListener('submit-composer', onSubmit);
    return () => {
      window.removeEventListener('focus-composer', onFocus);
      window.removeEventListener('submit-composer', onSubmit);
    };
  }, []);

  // ─── Render helpers ──────────────────────────────────────────────────

  const derivedLabel = useDerivedModeLabel(state, sourceTask);
  const showRepoChip = state.mode !== 'add-agent';
  const showBranchChip = state.mode === 'new';
  const showWorktreeToggle = state.mode === 'new' || state.mode === 'none';
  const showAttachChip = state.mode === 'new' || state.mode === 'existing' || state.mode === 'none';
  const disabledByAddAgent = state.mode === 'add-agent';

  return (
    <div
      className="flex flex-col gap-2 border-t border-border bg-background px-4 py-3"
      data-testid="composer"
    >
      {/* ─── Intent header ───────────────────────────────────────────── */}
      <IntentHeader
        state={state}
        sourceTask={sourceTask}
        sourceTaskMissing={sourceTaskMissing}
        onClear={onClearIntent}
      />

      {/* ─── Error banner ────────────────────────────────────────────── */}
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

      {/* ─── Chip row ────────────────────────────────────────────────── */}
      <div
        className={`flex flex-wrap items-center gap-2 ${disabledByAddAgent ? 'opacity-40 pointer-events-none' : ''}`}
        data-testid="chip-row"
      >
        <span className="select-none text-xs font-mono text-muted-foreground">🏠 Local</span>

        {showRepoChip && (
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

        {showBranchChip && state.mode === 'new' && (
          <BranchChip repoPath={state.repo} value={state.branch ?? ''} onChange={onPickBranch} />
        )}

        {showWorktreeToggle && (
          <WorktreeToggle
            value={state.mode === 'new' ? 'worktree' : 'in-place'}
            onChange={(v) => onToggleWorktree(v === 'worktree')}
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
      </div>

      {/* ─── Prompt + submit ─────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          data-testid="composer-prompt"
          className="min-h-[72px] resize-y border border-input bg-transparent px-3 py-2 text-sm font-mono outline-none focus:border-ring"
          placeholder={promptPlaceholder(state)}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onTextareaKeyDown}
          aria-label="Task prompt"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground" data-testid="derived-mode-label">
            {derivedLabel}
          </span>
          <div className="flex items-center gap-2">
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
            >
              {submitting ? 'DISPATCHING…' : 'DISPATCH ⏎'}
            </Button>
          </div>
        </div>
      </form>
    </div>
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

function useDerivedModeLabel(state: ComposerState, sourceTask: Task | null): string {
  switch (state.mode) {
    case 'empty':
      return '→ pick a repo or start typing';
    case 'scratch':
      return '→ scratch ⏎';
    case 'new':
      return '→ new worktree ⏎';
    case 'none':
      return '→ in-place ⏎';
    case 'existing':
      return '→ attach existing ⏎';
    case 'add-agent':
      return `→ add agent → ${sourceTask?.title ?? state.sessionId} ⏎`;
  }
}

function promptPlaceholder(state: ComposerState): string {
  if (state.mode === 'add-agent') return 'Instructions for the new agent…';
  if (state.mode === 'empty') return 'Describe a task or ask a question…';
  return 'Describe what you want the agent to do…';
}

// ─── Chip primitives ─────────────────────────────────────────────────────

function RepoChip({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!value && !expanded) {
    return (
      <ChipButton onClick={() => setExpanded(true)} data-testid="repo-chip-picker">
        📁 repo
      </ChipButton>
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
      label={`📁 ${repoBasename(value)}`}
      title={value}
      onRemove={onClear}
      data-testid="repo-chip"
    />
  );
}

function BranchChip({
  repoPath,
  value,
  onChange,
}: {
  repoPath: string;
  value: string;
  onChange: (branch: string) => void;
}) {
  return (
    <div className="flex items-center gap-1" data-testid="branch-chip">
      <span className="text-xs text-muted-foreground">⎇</span>
      <div className="min-w-[140px] max-w-[220px]">
        <BranchPickerField repoPath={repoPath} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function WorktreeToggle({
  value,
  onChange,
}: {
  value: 'worktree' | 'in-place';
  onChange: (v: 'worktree' | 'in-place') => void;
}) {
  return (
    <div
      className="inline-flex items-stretch border border-border text-[11px] font-mono"
      role="group"
      data-testid="worktree-toggle"
      aria-label="Worktree mode"
    >
      <button
        type="button"
        onClick={() => onChange('worktree')}
        className={`px-2 py-1 ${value === 'worktree' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        aria-pressed={value === 'worktree'}
        data-testid="worktree-toggle-worktree"
      >
        worktree
      </button>
      <button
        type="button"
        onClick={() => onChange('in-place')}
        className={`px-2 py-1 ${
          value === 'in-place'
            ? 'bg-amber-500/20 text-amber-300'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        aria-pressed={value === 'in-place'}
        data-testid="worktree-toggle-in-place"
      >
        in-place
      </button>
    </div>
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
      className="inline-flex items-center gap-1 border border-border px-2 py-1 text-[11px] font-mono"
    >
      <span>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}
