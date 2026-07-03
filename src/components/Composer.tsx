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
import { ComposerChipRow } from './ComposerChipRow';
import { ComposerInputPanel } from './ComposerInputPanel';
import { GlassPanel } from '@/components/ui/glass-panel';
import { cn } from '@/lib/utils';
import { taskApi } from '@/lib/api/taskApi';
import type { PreflightResult } from '@/lib/api/taskApi';
import { useTasksContext } from '@/lib/tasks-context';
import type { Task, Agent } from '@octomux/types';
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
  const { tasks, refresh, addOptimistic } = useTasksContext();

  const [state, dispatch] = useReducer(reduce, searchParams, (params: URLSearchParams) =>
    hydrateFromUrl(params),
  );

  const [prompt, setPrompt] = useState<string>(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [harnessId, setHarnessId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preflightBlock, setPreflightBlock] = useState<{
    result: PreflightResult;
    payload: Parameters<typeof taskApi.createTask>[0];
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
      const res = await taskApi.getDefaultBranch(repoPath);
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
          await taskApi.addAgent(state.sessionId, {
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
          const payload: Parameters<typeof taskApi.createTask>[0] = {
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
            const pre = await taskApi.preflightNoneMode(state.repo, state.branch);
            // Conflicts (different-branch active task) and dirty both block
            // creation. Same-branch warnings don't block but require an
            // explicit confirmation.
            if (!pre.ok || pre.warnings.length > 0) {
              setPreflightBlock({ result: pre, payload });
              return;
            }
          }

          const created = await taskApi.createTask(payload);
          localStorage.removeItem(DRAFT_KEY);
          setPrompt('');
          addOptimistic(created);
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
    [canSubmit, prompt, state, navigate, onSubmitted, refresh, addOptimistic, harnessId],
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

  const disabledByAddAgent = state.mode === 'add-agent';

  return (
    <GlassPanel
      level={3}
      className="composer-shell flex flex-col gap-2 overflow-hidden rounded-2xl px-4 py-3.5"
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
          className="flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
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

      <ComposerChipRow
        state={state}
        harnessId={harnessId}
        disabledByAddAgent={disabledByAddAgent}
        onPickRepo={onPickRepo}
        onClearRepo={onClearRepo}
        onPickBranch={onPickBranch}
        onToggleWorktree={onToggleWorktree}
        onSetExistingPath={onSetExistingPath}
        onClearExistingPath={onClearExistingPath}
        onPickAgent={onPickAgent}
        onToggleDraft={onToggleDraft}
        onHarnessChange={setHarnessId}
      />

      <div className="composer-divider" aria-hidden />

      <ComposerInputPanel
        prompt={prompt}
        placeholder={promptPlaceholder(state)}
        blockedReason={blockedReason}
        canSubmit={canSubmit}
        submitting={submitting}
        textareaRef={textareaRef}
        onPromptChange={setPrompt}
        onSubmit={handleSubmit}
        onKeyDown={onTextareaKeyDown}
      />
      {preflightBlock && preflightBlock.result.conflicts.length > 0 && (
        <NoneModeConflictDialog
          open
          conflicts={preflightBlock.result.conflicts}
          targetBranch={preflightBlock.result.targetBranch}
          onClose={() => setPreflightBlock(null)}
          onCloseTask={async (taskId) => {
            await taskApi.updateTask(taskId, { status: 'closed' });
            const repoForPreflight = preflightBlock.payload.repo_path!;
            const branchForPreflight = preflightBlock.payload.base_branch!;
            const next = await taskApi.preflightNoneMode(repoForPreflight, branchForPreflight);
            setPreflightBlock({ result: next, payload: preflightBlock.payload });
          }}
          onResolved={async () => {
            // Hand off to the dirty / shared-branch dialogs if those checks
            // now apply — their conditional renders will pick up the flow.
            if (preflightBlock.result.dirty) return;
            if (preflightBlock.result.warnings.length > 0) return;
            const created = await taskApi.createTask(preflightBlock.payload);
            setPreflightBlock(null);
            addOptimistic(created);
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
              await taskApi.stashRepo(
                preflightBlock.payload.repo_path!,
                preflightBlock.payload.base_branch!,
              );
              const created = await taskApi.createTask(preflightBlock.payload);
              setPreflightBlock(null);
              addOptimistic(created);
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
              const created = await taskApi.createTask(preflightBlock.payload);
              setPreflightBlock(null);
              addOptimistic(created);
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
      className={cn(
        'flex items-center justify-between rounded-lg border px-3 py-1.5 text-xs',
        isError
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-glass-edge bg-glass-l1/50 text-muted-foreground',
      )}
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
