import { describe, it, expect } from 'vitest';
import {
  reduce,
  hydrateFromUrl,
  stateToUrlParams,
  validateForSubmit,
  deriveRunMode,
  INITIAL_STATE,
  type ComposerState,
  type ComposerAction,
} from './composer-state';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const empty: ComposerState = { mode: 'empty' };
const scratch: ComposerState = { mode: 'scratch', isDraft: false };
const newState: ComposerState = {
  mode: 'new',
  repo: '/r',
  branch: 'main',
  isDraft: false,
};
const noneState: ComposerState = {
  mode: 'none',
  repo: '/r',
  branch: 'main',
  isDraft: false,
};
const existingState: ComposerState = {
  mode: 'existing',
  repo: '/r',
  worktreePath: '/r/.worktrees/abc',
  isDraft: false,
  lastBranch: 'main',
};
const addAgent: ComposerState = {
  mode: 'add-agent',
  sessionId: 't1',
};

// ─── pickRepo transitions ─────────────────────────────────────────────────

describe('reduce / pickRepo', () => {
  const cases: Array<{ from: ComposerState; expectedMode: string }> = [
    // Fresh pick: worktree checkbox starts OFF → `none` mode.
    { from: empty, expectedMode: 'none' },
    { from: scratch, expectedMode: 'none' },
    // Repo swap within `new` preserves the on-state of the checkbox.
    { from: newState, expectedMode: 'new' },
    // Repo swap within `none` preserves the off-state.
    { from: noneState, expectedMode: 'none' },
    { from: existingState, expectedMode: 'existing' },
  ];
  it.each(cases)('$from.mode → $expectedMode on pickRepo', ({ from, expectedMode }) => {
    const next = reduce(from, { type: 'pickRepo', repo: '/r2', defaultBranch: 'dev' });
    expect(next.mode).toBe(expectedMode);
  });

  it('pickRepo from empty yields none with default branch (worktree OFF by default)', () => {
    const next = reduce(empty, { type: 'pickRepo', repo: '/r', defaultBranch: 'main' });
    expect(next).toEqual({ mode: 'none', repo: '/r', branch: 'main', isDraft: false });
  });

  it('pickRepo preserves isDraft', () => {
    const draftScratch: ComposerState = { mode: 'scratch', isDraft: true };
    const next = reduce(draftScratch, { type: 'pickRepo', repo: '/r', defaultBranch: 'main' });
    expect(next).toMatchObject({ mode: 'none', isDraft: true });
  });

  it('pickRepo preserves forkOf from new mode', () => {
    const withFork: ComposerState = { ...newState, forkOf: 't1' };
    const next = reduce(withFork, { type: 'pickRepo', repo: '/r2', defaultBranch: 'x' });
    expect(next).toMatchObject({ mode: 'new', repo: '/r2', branch: 'x', forkOf: 't1' });
  });

  it('pickRepo is a no-op in add-agent mode', () => {
    const next = reduce(addAgent, { type: 'pickRepo', repo: '/r', defaultBranch: 'main' });
    expect(next).toBe(addAgent);
  });

  it('pickRepo on existing only updates the repo, keeping attach path', () => {
    const next = reduce(existingState, { type: 'pickRepo', repo: '/r2', defaultBranch: 'x' });
    expect(next).toMatchObject({
      mode: 'existing',
      repo: '/r2',
      worktreePath: '/r/.worktrees/abc',
    });
  });
});

// ─── clearRepo transitions ────────────────────────────────────────────────

describe('reduce / clearRepo', () => {
  it('new → scratch', () => {
    expect(reduce(newState, { type: 'clearRepo' })).toEqual({
      mode: 'scratch',
      isDraft: false,
    });
  });
  it('none → scratch', () => {
    expect(reduce(noneState, { type: 'clearRepo' })).toEqual({
      mode: 'scratch',
      isDraft: false,
    });
  });
  it('existing → scratch', () => {
    expect(reduce(existingState, { type: 'clearRepo' })).toEqual({
      mode: 'scratch',
      isDraft: false,
    });
  });
  it('scratch stays scratch', () => {
    expect(reduce(scratch, { type: 'clearRepo' })).toEqual({ mode: 'scratch', isDraft: false });
  });
  it('empty stays empty', () => {
    expect(reduce(empty, { type: 'clearRepo' })).toBe(empty);
  });
  it('add-agent stays add-agent', () => {
    expect(reduce(addAgent, { type: 'clearRepo' })).toBe(addAgent);
  });
});

// ─── pickBranch transitions ───────────────────────────────────────────────

describe('reduce / pickBranch', () => {
  it('sets branch on new', () => {
    const next = reduce(newState, { type: 'pickBranch', branch: 'dev' });
    expect(next).toMatchObject({ mode: 'new', branch: 'dev' });
  });
  it('sets branch on none', () => {
    const next = reduce(noneState, { type: 'pickBranch', branch: 'dev' });
    expect(next).toMatchObject({ mode: 'none', branch: 'dev' });
  });
  it('stores as lastBranch on existing', () => {
    const next = reduce(existingState, { type: 'pickBranch', branch: 'dev' });
    expect(next).toMatchObject({ mode: 'existing', lastBranch: 'dev' });
  });
  it.each([empty, scratch, addAgent])('no-op on $mode', (from) => {
    expect(reduce(from, { type: 'pickBranch', branch: 'x' })).toBe(from);
  });
});

// ─── toggleWorktree transitions ───────────────────────────────────────────

describe('reduce / toggleWorktree', () => {
  it('new + toggle off → none', () => {
    const next = reduce(newState, { type: 'toggleWorktree', worktree: false });
    expect(next).toEqual({
      mode: 'none',
      repo: '/r',
      branch: 'main',
      isDraft: false,
    });
  });
  it('none + toggle on → new', () => {
    const next = reduce(noneState, { type: 'toggleWorktree', worktree: true });
    expect(next).toEqual({
      mode: 'new',
      repo: '/r',
      branch: 'main',
      isDraft: false,
    });
  });
  it('new + toggle on is a no-op', () => {
    expect(reduce(newState, { type: 'toggleWorktree', worktree: true })).toBe(newState);
  });
  it('none + toggle off is a no-op', () => {
    expect(reduce(noneState, { type: 'toggleWorktree', worktree: false })).toBe(noneState);
  });
  it('existing ignores worktree toggle (attach overrides)', () => {
    expect(reduce(existingState, { type: 'toggleWorktree', worktree: false })).toBe(existingState);
    expect(reduce(existingState, { type: 'toggleWorktree', worktree: true })).toBe(existingState);
  });
  it('toggleWorktree off drops forkOf label', () => {
    const withFork: ComposerState = { ...newState, forkOf: 'src1' };
    const next = reduce(withFork, { type: 'toggleWorktree', worktree: false });
    expect(next).toMatchObject({ mode: 'none' });
    expect(next).not.toHaveProperty('forkOf');
  });
});

// ─── setExistingPath transitions ──────────────────────────────────────────

describe('reduce / setExistingPath', () => {
  it('new → existing with lastBranch captured', () => {
    const next = reduce(newState, { type: 'setExistingPath', path: '/p' });
    expect(next).toEqual({
      mode: 'existing',
      repo: '/r',
      worktreePath: '/p',
      isDraft: false,
      lastBranch: 'main',
    });
  });
  it('none → existing with lastBranch captured', () => {
    const next = reduce(noneState, { type: 'setExistingPath', path: '/p' });
    expect(next).toMatchObject({ mode: 'existing', worktreePath: '/p', lastBranch: 'main' });
  });
  it('existing → existing with updated path', () => {
    const next = reduce(existingState, { type: 'setExistingPath', path: '/p2' });
    expect(next).toMatchObject({ mode: 'existing', worktreePath: '/p2' });
  });
  it.each([empty, scratch, addAgent])('no-op on $mode (no repo to attach to)', (from) => {
    expect(reduce(from, { type: 'setExistingPath', path: '/p' })).toBe(from);
  });
});

// ─── clearExistingPath transitions ────────────────────────────────────────

describe('reduce / clearExistingPath', () => {
  it('existing → new with lastBranch restored', () => {
    const next = reduce(existingState, { type: 'clearExistingPath' });
    expect(next).toEqual({
      mode: 'new',
      repo: '/r',
      branch: 'main',
      isDraft: false,
    });
  });
  it('existing without lastBranch → new with null branch', () => {
    const noLast: ComposerState = { ...existingState, lastBranch: undefined };
    const next = reduce(noLast, { type: 'clearExistingPath' });
    expect(next).toMatchObject({ mode: 'new', branch: null });
  });
  it.each([empty, scratch, newState, noneState, addAgent])('no-op on $mode', (from) => {
    expect(reduce(from, { type: 'clearExistingPath' })).toBe(from);
  });
});

// ─── enterAddAgent transitions ────────────────────────────────────────────

describe('reduce / enterAddAgent', () => {
  it.each([empty, scratch, newState, noneState, existingState, addAgent])(
    'every state → add-agent (suppresses other chips)',
    (from) => {
      const next = reduce(from, { type: 'enterAddAgent', sessionId: 'sess' });
      expect(next).toEqual({ mode: 'add-agent', sessionId: 'sess' });
    },
  );

  it('carries agentType and label when provided', () => {
    const next = reduce(empty, {
      type: 'enterAddAgent',
      sessionId: 'sess',
      agentType: 'reviewer',
      label: 'reviewer#2',
    });
    expect(next).toEqual({
      mode: 'add-agent',
      sessionId: 'sess',
      agentType: 'reviewer',
      label: 'reviewer#2',
    });
  });
});

// ─── clearIntent transitions ──────────────────────────────────────────────

describe('reduce / clearIntent', () => {
  it('add-agent → scratch', () => {
    expect(reduce(addAgent, { type: 'clearIntent' })).toEqual({
      mode: 'scratch',
      isDraft: false,
    });
  });
  it('new with forkOf → new without forkOf', () => {
    const withFork: ComposerState = { ...newState, forkOf: 'src1' };
    const next = reduce(withFork, { type: 'clearIntent' });
    expect(next).toEqual(newState);
  });
  it.each([empty, scratch, newState, noneState, existingState])('other modes unchanged', (from) => {
    expect(reduce(from, { type: 'clearIntent' })).toBe(from);
  });
});

// ─── toggleDraft transitions ──────────────────────────────────────────────

describe('reduce / toggleDraft', () => {
  it.each([newState, noneState, existingState, scratch])('toggles isDraft on $mode', (from) => {
    const next = reduce(from, { type: 'toggleDraft' });
    expect(next).toMatchObject({ isDraft: true });
    const back = reduce(next, { type: 'toggleDraft' });
    expect(back).toMatchObject({ isDraft: false });
  });
  it.each([empty, addAgent])('no-op on $mode', (from) => {
    expect(reduce(from, { type: 'toggleDraft' })).toBe(from);
  });
});

// ─── hydrateFromUrl ───────────────────────────────────────────────────────

describe('hydrateFromUrl', () => {
  const table: Array<{ name: string; qs: string; expected: ComposerState }> = [
    {
      name: 'empty URL → scratch state',
      qs: '',
      expected: { mode: 'scratch', isDraft: false },
    },
    {
      name: '?mode=scratch → scratch (same as bare URL)',
      qs: 'mode=scratch',
      expected: { mode: 'scratch', isDraft: false },
    },
    {
      // New default: repo without explicit mode means worktree checkbox is off.
      name: '?repo=/r → none with null branch (worktree OFF default)',
      qs: 'repo=%2Fr',
      expected: { mode: 'none', repo: '/r', branch: null, isDraft: false },
    },
    {
      name: '?repo=/r&branch=dev → none with dev',
      qs: 'repo=%2Fr&branch=dev',
      expected: { mode: 'none', repo: '/r', branch: 'dev', isDraft: false },
    },
    {
      name: '?repo=/r&base_branch=main → none with main',
      qs: 'repo=%2Fr&base_branch=main',
      expected: { mode: 'none', repo: '/r', branch: 'main', isDraft: false },
    },
    {
      name: '?repo=/r&mode=new → new (worktree ON)',
      qs: 'repo=%2Fr&mode=new',
      expected: { mode: 'new', repo: '/r', branch: null, isDraft: false },
    },
    {
      name: '?repo=/r&worktree=1 → new (worktree ON via explicit flag)',
      qs: 'repo=%2Fr&worktree=1',
      expected: { mode: 'new', repo: '/r', branch: null, isDraft: false },
    },
    {
      name: '?repo=/r&fork_of=x → new with forkOf (fork_of implies worktree ON)',
      qs: 'repo=%2Fr&fork_of=x',
      expected: { mode: 'new', repo: '/r', branch: null, isDraft: false, forkOf: 'x' },
    },
    {
      name: '?repo=/r&mode=new&fork_of=x → new with forkOf',
      qs: 'repo=%2Fr&mode=new&fork_of=x',
      expected: { mode: 'new', repo: '/r', branch: null, isDraft: false, forkOf: 'x' },
    },
    {
      name: '?repo=/r&mode=none → none',
      qs: 'repo=%2Fr&mode=none',
      expected: { mode: 'none', repo: '/r', branch: null, isDraft: false },
    },
    {
      name: '?repo=/r&worktree=0 → none',
      qs: 'repo=%2Fr&worktree=0',
      expected: { mode: 'none', repo: '/r', branch: null, isDraft: false },
    },
    {
      name: '?repo=/r&mode=existing&worktree_path=/p → existing',
      qs: 'repo=%2Fr&mode=existing&worktree_path=%2Fp',
      expected: {
        mode: 'existing',
        repo: '/r',
        worktreePath: '/p',
        isDraft: false,
        lastBranch: null,
      },
    },
    {
      name: '?add_agent=sess → add-agent',
      qs: 'add_agent=sess',
      expected: { mode: 'add-agent', sessionId: 'sess' },
    },
    {
      name: '?add_agent=sess&repo=/r (add_agent wins)',
      qs: 'add_agent=sess&repo=%2Fr',
      expected: { mode: 'add-agent', sessionId: 'sess' },
    },
  ];

  it.each(table)('$name', ({ qs, expected }) => {
    const state = hydrateFromUrl(new URLSearchParams(qs));
    expect(state).toEqual(expected);
  });

  it('dispatches hydrateFromUrl via reduce()', () => {
    const next = reduce(empty, {
      type: 'hydrateFromUrl',
      params: new URLSearchParams('repo=%2Fr&mode=new'),
    });
    expect(next).toMatchObject({ mode: 'new', repo: '/r' });
  });

  // Per T5 spec: explicit `mode=new` must produce repo + worktree=on (i.e. `mode:'new'`).
  it('hydrateFromUrl({ repo, mode: "new" }) → repo set + worktree ON (mode=new)', () => {
    const state = hydrateFromUrl(new URLSearchParams('repo=%2Fr&mode=new&branch=main'));
    expect(state).toEqual({
      mode: 'new',
      repo: '/r',
      branch: 'main',
      isDraft: false,
    });
  });
});

// ─── stateToUrlParams round-trip ──────────────────────────────────────────

describe('stateToUrlParams', () => {
  const roundtrips: ComposerState[] = [
    { mode: 'scratch', isDraft: false },
    { mode: 'new', repo: '/r', branch: 'main', isDraft: false },
    { mode: 'new', repo: '/r', branch: 'main', isDraft: false, forkOf: 'src1' },
    { mode: 'none', repo: '/r', branch: 'main', isDraft: false },
    { mode: 'existing', repo: '/r', worktreePath: '/p', isDraft: false },
    { mode: 'add-agent', sessionId: 'sess' },
  ];

  it.each(roundtrips)('$mode round-trips through URL', (state) => {
    const params = stateToUrlParams(state);
    const parsed = hydrateFromUrl(params);
    // lastBranch/isDraft are transient; core identity must match.
    expect(parsed.mode).toBe(state.mode);
    if (state.mode === 'new' || state.mode === 'none') {
      const typedState = state as Extract<ComposerState, { mode: 'new' | 'none' }>;
      expect(parsed).toMatchObject({ repo: typedState.repo, branch: typedState.branch });
      if (state.mode === 'new' && state.forkOf) {
        expect(parsed).toMatchObject({ forkOf: state.forkOf });
      }
    }
    if (state.mode === 'existing') {
      expect(parsed).toMatchObject({ repo: state.repo, worktreePath: state.worktreePath });
    }
    if (state.mode === 'add-agent') {
      expect(parsed).toMatchObject({ sessionId: state.sessionId });
    }
  });
});

// ─── validateForSubmit ────────────────────────────────────────────────────

describe('validateForSubmit', () => {
  it('blocks empty prompts always', () => {
    expect(validateForSubmit(scratch, '')).toMatch(/prompt is required/i);
    expect(validateForSubmit(scratch, '   ')).toMatch(/prompt is required/i);
  });
  it('blocks empty state regardless of prompt', () => {
    expect(validateForSubmit(empty, 'hi')).toBeTruthy();
  });
  it('allows scratch with non-empty prompt', () => {
    expect(validateForSubmit(scratch, 'hello')).toBeNull();
  });
  it('scratch with prompt "hello" returns no blocking reason', () => {
    expect(validateForSubmit({ mode: 'scratch', isDraft: false }, 'hello')).toBeNull();
  });
  it('scratch with empty prompt blocks with a prompt-required reason', () => {
    expect(validateForSubmit({ mode: 'scratch', isDraft: false }, '')).toMatch(
      /prompt is required/i,
    );
  });
  it('requires branch for new mode', () => {
    expect(validateForSubmit({ ...newState, branch: null }, 'p')).toMatch(/branch/i);
    expect(validateForSubmit(newState, 'p')).toBeNull();
  });
  it('requires repo and worktreePath for existing', () => {
    expect(validateForSubmit({ ...existingState, worktreePath: '' }, 'p')).toMatch(/worktree/i);
    expect(validateForSubmit(existingState, 'p')).toBeNull();
  });
  it('allows none with repo', () => {
    expect(validateForSubmit(noneState, 'p')).toBeNull();
  });
  it('requires sessionId for add-agent', () => {
    expect(validateForSubmit(addAgent, 'p')).toBeNull();
  });
});

// ─── deriveRunMode — T5: run_mode is derived from (repo ∧ worktree) ──────

describe('deriveRunMode', () => {
  it('empty composer (no repo) → "scratch"', () => {
    expect(deriveRunMode(scratch)).toBe('scratch');
  });

  it('repo + worktree ON → "new"', () => {
    // Simulate "user clicked add repo, then checked the worktree box".
    const afterPickRepo = reduce(empty, { type: 'pickRepo', repo: '/r', defaultBranch: 'main' });
    const afterCheck = reduce(afterPickRepo, { type: 'toggleWorktree', worktree: true });
    expect(deriveRunMode(afterCheck)).toBe('new');
  });

  it('repo + worktree OFF → "none"', () => {
    // Default on first pick: worktree off → none.
    const afterPickRepo = reduce(empty, { type: 'pickRepo', repo: '/r', defaultBranch: 'main' });
    expect(deriveRunMode(afterPickRepo)).toBe('none');
  });

  it('attach chip takes precedence → "existing"', () => {
    const afterPickRepo = reduce(empty, { type: 'pickRepo', repo: '/r', defaultBranch: 'main' });
    const afterAttach = reduce(afterPickRepo, { type: 'setExistingPath', path: '/p' });
    expect(deriveRunMode(afterAttach)).toBe('existing');
  });
});

// ─── INITIAL_STATE ────────────────────────────────────────────────────────

describe('INITIAL_STATE', () => {
  it('is empty', () => {
    expect(INITIAL_STATE).toEqual({ mode: 'empty' });
  });
});

// ─── Exhaustiveness sanity: every action × every starting mode ────────────

describe('reduce / exhaustiveness (action × mode)', () => {
  const modes: ComposerState[] = [empty, scratch, newState, noneState, existingState, addAgent];
  const actions: ComposerAction[] = [
    { type: 'pickRepo', repo: '/r', defaultBranch: 'main' },
    { type: 'clearRepo' },
    { type: 'pickBranch', branch: 'x' },
    { type: 'toggleWorktree', worktree: true },
    { type: 'toggleWorktree', worktree: false },
    { type: 'setExistingPath', path: '/p' },
    { type: 'clearExistingPath' },
    { type: 'enterAddAgent', sessionId: 'sess' },
    { type: 'clearIntent' },
    { type: 'toggleDraft' },
  ];
  const matrix = modes.flatMap((m) => actions.map((a) => ({ mode: m.mode, type: a.type, m, a })));
  it.each(matrix)('$mode + $type → returns a valid ComposerState', ({ m, a }) => {
    const next = reduce(m, a);
    expect(next).toHaveProperty('mode');
    expect(['empty', 'scratch', 'new', 'none', 'existing', 'add-agent'].includes(next.mode)).toBe(
      true,
    );
  });
});
