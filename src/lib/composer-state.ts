/**
 * Composer state machine for the Home chip-row composer.
 *
 * The four run modes (new / existing / none / scratch) plus add-agent are DERIVED
 * from chip state. The reducer encodes precedence rules so that every user
 * interaction with a chip results in exactly one valid state.
 */

export type ComposerMode = 'empty' | 'new' | 'existing' | 'none' | 'scratch' | 'add-agent';

export type ComposerState =
  | { mode: 'empty' }
  | {
      mode: 'new';
      repo: string;
      branch: string | null;
      isDraft: boolean;
      forkOf?: string;
    }
  | {
      mode: 'existing';
      repo: string;
      worktreePath: string;
      isDraft: boolean;
      /** Remembered from `new` mode so clearing the attach path can restore it. */
      lastBranch?: string | null;
    }
  | {
      mode: 'none';
      repo: string;
      branch: string | null;
      isDraft: boolean;
    }
  | {
      mode: 'scratch';
      isDraft: boolean;
    }
  | {
      mode: 'add-agent';
      sessionId: string;
      agentType?: string;
      label?: string;
    };

export type ComposerAction =
  | { type: 'pickRepo'; repo: string; defaultBranch: string | null }
  | { type: 'clearRepo' }
  | { type: 'pickBranch'; branch: string }
  | { type: 'toggleWorktree'; worktree: boolean }
  | { type: 'setExistingPath'; path: string }
  | { type: 'clearExistingPath' }
  | { type: 'enterAddAgent'; sessionId: string; agentType?: string; label?: string }
  | { type: 'clearIntent' }
  | { type: 'toggleDraft' }
  | { type: 'hydrateFromUrl'; params: URLSearchParams };

export const INITIAL_STATE: ComposerState = { mode: 'empty' };

export function reduce(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'pickRepo': {
      const { repo, defaultBranch } = action;
      if (state.mode === 'add-agent') return state;
      if (state.mode === 'existing') {
        return { ...state, repo };
      }
      // From empty / scratch / new / none — produce a `new` with the repo's default branch and worktree ON.
      const isDraft = 'isDraft' in state ? state.isDraft : false;
      const forkOf = state.mode === 'new' ? state.forkOf : undefined;
      return { mode: 'new', repo, branch: defaultBranch, isDraft, ...(forkOf ? { forkOf } : {}) };
    }

    case 'clearRepo': {
      if (state.mode === 'add-agent' || state.mode === 'empty') return state;
      const isDraft = 'isDraft' in state ? state.isDraft : false;
      return { mode: 'scratch', isDraft };
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
        return { mode: 'new', repo: state.repo, branch: state.branch, isDraft: state.isDraft };
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
          lastBranch: state.branch,
        };
      }
      if (state.mode === 'none') {
        return {
          mode: 'existing',
          repo: state.repo,
          worktreePath: action.path,
          isDraft: state.isDraft,
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
      };
    }

    case 'enterAddAgent': {
      return {
        mode: 'add-agent',
        sessionId: action.sessionId,
        ...(action.agentType ? { agentType: action.agentType } : {}),
        ...(action.label ? { label: action.label } : {}),
      };
    }

    case 'clearIntent': {
      if (state.mode === 'add-agent') return { mode: 'empty' };
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
 * Precedence: add_agent > repo+mode/attach > scratch. Unknown combinations fall back
 * sensibly (e.g. ?repo without ?mode defaults to `new`).
 */
export function hydrateFromUrl(params: URLSearchParams): ComposerState {
  const addAgent = params.get('add_agent');
  if (addAgent) {
    return {
      mode: 'add-agent',
      sessionId: addAgent,
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
    if (modeParam === 'scratch') {
      return { mode: 'scratch', isDraft: false };
    }
    return { mode: 'empty' };
  }

  if (existingPath || modeParam === 'existing') {
    return {
      mode: 'existing',
      repo,
      worktreePath: existingPath ?? '',
      isDraft: false,
      lastBranch: branch,
    };
  }

  if (modeParam === 'none' || worktreeParam === '0') {
    return {
      mode: 'none',
      repo,
      branch: branch ?? null,
      isDraft: false,
    };
  }

  return {
    mode: 'new',
    repo,
    branch: branch ?? null,
    isDraft: false,
    ...(forkOf ? { forkOf } : {}),
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
      break;
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
