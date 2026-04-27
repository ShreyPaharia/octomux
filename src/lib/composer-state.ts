/**
 * Composer state machine for the Home chip-row composer.
 *
 * `run_mode` is DERIVED from chip state — the composer no longer has an explicit
 * mode chip. The mapping is:
 *   - no repo                       → 'scratch'
 *   - repo + worktree unchecked     → 'none'   (attach to branch's working tree)
 *   - repo + worktree checked       → 'new'    (fresh worktree)
 *   - repo + attach path            → 'existing' (advanced; reachable via the
 *                                                 attach chip)
 * Every user interaction produces exactly one valid state; there is no
 * `setMode` action.
 */

export type ComposerMode = 'empty' | 'new' | 'existing' | 'none' | 'scratch' | 'add-agent';

export type ComposerState =
  | { mode: 'empty' }
  | {
      mode: 'new';
      repo: string;
      branch: string | null;
      isDraft: boolean;
      agent: string | null;
      forkOf?: string;
    }
  | {
      mode: 'existing';
      repo: string;
      worktreePath: string;
      isDraft: boolean;
      agent: string | null;
      /** Remembered from `new` mode so clearing the attach path can restore it. */
      lastBranch?: string | null;
    }
  | {
      mode: 'none';
      repo: string;
      branch: string | null;
      isDraft: boolean;
      agent: string | null;
    }
  | {
      mode: 'scratch';
      isDraft: boolean;
      agent: string | null;
    }
  | {
      mode: 'add-agent';
      sessionId: string;
      agentType?: string;
      label?: string;
      agent: string | null;
    };

export type ComposerAction =
  | { type: 'pickRepo'; repo: string; defaultBranch: string | null }
  | { type: 'clearRepo' }
  | { type: 'pickBranch'; branch: string }
  | { type: 'toggleWorktree'; worktree: boolean }
  | { type: 'setExistingPath'; path: string }
  | { type: 'clearExistingPath' }
  | { type: 'enterAddAgent'; sessionId: string; agentType?: string; label?: string }
  | { type: 'pickAgent'; agent: string | null }
  | { type: 'clearIntent' }
  | { type: 'toggleDraft' }
  | { type: 'hydrateFromUrl'; params: URLSearchParams };

export const INITIAL_STATE: ComposerState = { mode: 'empty' };

/** Carry-over `agent` field across mode transitions (or null when starting fresh). */
function carryAgent(state: ComposerState): string | null {
  return 'agent' in state ? (state.agent ?? null) : null;
}

export function reduce(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'pickRepo': {
      const { repo, defaultBranch } = action;
      if (state.mode === 'add-agent') return state;
      if (state.mode === 'existing') {
        return { ...state, repo };
      }
      const isDraft = 'isDraft' in state ? state.isDraft : false;
      const agent = carryAgent(state);
      // Preserve worktree-on when we were already in `new` (and carry any fork intent).
      if (state.mode === 'new') {
        const forkOf = state.forkOf;
        return {
          mode: 'new',
          repo,
          branch: defaultBranch,
          isDraft,
          agent,
          ...(forkOf ? { forkOf } : {}),
        };
      }
      // First repo pick from empty / scratch, and repo swap from `none`:
      // worktree checkbox starts OFF → `none` mode.
      return { mode: 'none', repo, branch: defaultBranch, isDraft, agent };
    }

    case 'clearRepo': {
      if (state.mode === 'add-agent' || state.mode === 'empty') return state;
      const isDraft = 'isDraft' in state ? state.isDraft : false;
      return { mode: 'scratch', isDraft, agent: carryAgent(state) };
    }

    case 'pickBranch': {
      if (state.mode === 'new' || state.mode === 'none') {
        return { ...state, branch: action.branch };
      }
      if (state.mode === 'existing') {
        return { ...state, lastBranch: action.branch };
      }
      return state;
    }

    case 'toggleWorktree': {
      if (state.mode === 'new' && !action.worktree) {
        const { forkOf: _forkOf, ...rest } = state;
        return { ...rest, mode: 'none' };
      }
      if (state.mode === 'none' && action.worktree) {
        return {
          mode: 'new',
          repo: state.repo,
          branch: state.branch,
          isDraft: state.isDraft,
          agent: state.agent,
        };
      }
      return state;
    }

    case 'setExistingPath': {
      if (state.mode === 'new') {
        return {
          mode: 'existing',
          repo: state.repo,
          worktreePath: action.path,
          isDraft: state.isDraft,
          agent: state.agent,
          lastBranch: state.branch,
        };
      }
      if (state.mode === 'none') {
        return {
          mode: 'existing',
          repo: state.repo,
          worktreePath: action.path,
          isDraft: state.isDraft,
          agent: state.agent,
          lastBranch: state.branch,
        };
      }
      if (state.mode === 'existing') {
        return { ...state, worktreePath: action.path };
      }
      return state;
    }

    case 'clearExistingPath': {
      if (state.mode !== 'existing') return state;
      return {
        mode: 'new',
        repo: state.repo,
        branch: state.lastBranch ?? null,
        isDraft: state.isDraft,
        agent: state.agent,
      };
    }

    case 'enterAddAgent': {
      return {
        mode: 'add-agent',
        sessionId: action.sessionId,
        agent: carryAgent(state),
        ...(action.agentType ? { agentType: action.agentType } : {}),
        ...(action.label ? { label: action.label } : {}),
      };
    }

    case 'pickAgent': {
      if (state.mode === 'empty') return state;
      return { ...state, agent: action.agent };
    }

    case 'clearIntent': {
      if (state.mode === 'add-agent')
        return { mode: 'scratch', isDraft: false, agent: state.agent };
      if (state.mode === 'new' && state.forkOf) {
        const { forkOf: _forkOf, ...rest } = state;
        return rest;
      }
      return state;
    }

    case 'toggleDraft': {
      if (state.mode === 'empty' || state.mode === 'add-agent') return state;
      return { ...state, isDraft: !state.isDraft };
    }

    case 'hydrateFromUrl': {
      return hydrateFromUrl(action.params);
    }
  }
}

/**
 * Parse URL search params into an initial ComposerState.
 *
 * Precedence: add_agent > repo+attach > repo+mode > scratch. Mirrors the
 * UI-level derivation: `?repo` without `?mode=new` means the worktree checkbox
 * is unchecked → `none`. Only explicit `?mode=new` (or `worktree=1`) produces a
 * fresh worktree.
 */
export function hydrateFromUrl(params: URLSearchParams): ComposerState {
  const agent = params.get('agent');
  const addAgent = params.get('add_agent');
  if (addAgent) {
    return {
      mode: 'add-agent',
      sessionId: addAgent,
      agent,
      ...(params.get('agent_type') ? { agentType: params.get('agent_type')! } : {}),
      ...(params.get('label') ? { label: params.get('label')! } : {}),
    };
  }

  const repo = params.get('repo');
  const branch = params.get('branch') ?? params.get('base_branch');
  const modeParam = params.get('mode');
  const worktreeParam = params.get('worktree');
  const forkOf = params.get('fork_of');
  const existingPath = params.get('worktree_path') ?? params.get('attach');

  if (!repo) {
    return { mode: 'scratch', isDraft: false, agent };
  }

  if (existingPath || modeParam === 'existing') {
    return {
      mode: 'existing',
      repo,
      worktreePath: existingPath ?? '',
      isDraft: false,
      agent,
      lastBranch: branch,
    };
  }

  if (modeParam === 'new' || worktreeParam === '1' || forkOf) {
    return {
      mode: 'new',
      repo,
      branch: branch ?? null,
      isDraft: false,
      agent,
      ...(forkOf ? { forkOf } : {}),
    };
  }

  // Default: repo present but no worktree intent → attach in-place.
  return {
    mode: 'none',
    repo,
    branch: branch ?? null,
    isDraft: false,
    agent,
  };
}

/**
 * Serialize ComposerState back to URL search params. Mirrors chip state into
 * the URL so that deep links and browser back/forward restore the composer.
 * Prompt text is NOT included (stays local to the component).
 */
export function stateToUrlParams(state: ComposerState): URLSearchParams {
  const params = new URLSearchParams();
  switch (state.mode) {
    case 'empty':
      return params;
    case 'scratch':
      params.set('mode', 'scratch');
      break;
    case 'new':
      params.set('repo', state.repo);
      params.set('mode', 'new');
      if (state.branch) params.set('branch', state.branch);
      if (state.forkOf) params.set('fork_of', state.forkOf);
      break;
    case 'none':
      params.set('repo', state.repo);
      params.set('mode', 'none');
      if (state.branch) params.set('branch', state.branch);
      break;
    case 'existing':
      params.set('repo', state.repo);
      params.set('mode', 'existing');
      if (state.worktreePath) params.set('worktree_path', state.worktreePath);
      break;
    case 'add-agent':
      params.set('add_agent', state.sessionId);
      if (state.agentType) params.set('agent_type', state.agentType);
      if (state.label) params.set('label', state.label);
      break;
  }
  if ('agent' in state && state.agent) params.set('agent', state.agent);
  return params;
}

/**
 * The derived run mode is the `mode` field itself. This helper exists mostly
 * for readability at call sites + as a single place to extend if we ever need
 * to derive differently (e.g. prompt-based auto-mode selection).
 */
export function deriveRunMode(state: ComposerState): ComposerMode {
  return state.mode;
}

/**
 * Whether the composer has enough chip state to submit, given a prompt string.
 * Returns a reason message when blocked, or null when OK.
 */
export function validateForSubmit(state: ComposerState, prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!trimmed) return 'Prompt is required';
  switch (state.mode) {
    case 'empty':
      return 'Describe what you want to do, or pick a repo';
    case 'scratch':
      return null;
    case 'new':
      if (!state.repo) return 'Pick a repo';
      if (!state.branch) return 'Pick a base branch';
      return null;
    case 'none':
      if (!state.repo) return 'Pick a repo';
      return null;
    case 'existing':
      if (!state.repo) return 'Pick a repo';
      if (!state.worktreePath) return 'Pick an existing worktree path';
      return null;
    case 'add-agent':
      if (!state.sessionId) return 'Missing session';
      return null;
  }
}
