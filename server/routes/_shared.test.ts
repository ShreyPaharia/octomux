import { describe, it, expect, vi, beforeEach, afterEach } from '../bun-test.js';

// resolveAiTaskNamingEnabled reads settings.js's getSettings() when
// OCTOMUX_AI_TASK_NAMING is unset — stub it so tests control the resolution
// order without touching the real filesystem.
const mockGetSettings = vi.fn(async () => ({}) as { aiTaskNaming?: boolean });
vi.mock('../settings.js', () => ({ getSettings: () => mockGetSettings() }));

// title-gen.js shells out to the Claude CLI — never invoked by these tests
// (aiTaskNamingEnabled is what's under test, not the polish call itself),
// but must not blow up module resolution.
vi.mock('../title-gen.js', () => ({ generateTitleAndDescription: vi.fn() }));

const { resolveAiTaskNamingEnabled, lookupExistingReviewId, validateCreateTaskBody } =
  await import('./_shared.js');
const { createTestDb, insertTask } = await import('../test-helpers.js');
const { getDb } = await import('../db.js');
const { CORE_COMPUTE_KINDS } = await import('../compute/index.js');

describe('resolveAiTaskNamingEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OCTOMUX_AI_TASK_NAMING;
    mockGetSettings.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.OCTOMUX_AI_TASK_NAMING;
  });

  it.each([
    { name: 'env "1" overrides stored settings false', env: '1', stored: false, expected: true },
    {
      name: 'env "true" overrides stored settings false',
      env: 'true',
      stored: false,
      expected: true,
    },
    { name: 'env "0" overrides stored settings true', env: '0', stored: true, expected: false },
    {
      name: 'stored settings true is used when env is absent',
      env: undefined,
      stored: true,
      expected: true,
    },
    {
      name: 'stored settings false is used when env is absent',
      env: undefined,
      stored: false,
      expected: false,
    },
    {
      name: 'hardcoded default (false) is used when both env and stored are absent',
      env: undefined,
      stored: undefined,
      expected: false,
    },
  ])('$name', async ({ env, stored, expected }) => {
    if (env !== undefined) process.env.OCTOMUX_AI_TASK_NAMING = env;
    mockGetSettings.mockResolvedValue({ aiTaskNaming: stored });

    await expect(resolveAiTaskNamingEnabled()).resolves.toBe(expected);
  });

  it('falls back to false when settings.js throws', async () => {
    mockGetSettings.mockRejectedValue(new Error('settings unavailable'));
    await expect(resolveAiTaskNamingEnabled()).resolves.toBe(false);
  });
});

describe('lookupExistingReviewId', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('does not match a same-numbered PR review task in a different repo', () => {
    // Regression test: PR numbers are per-repo, so a review task for PR #42 in
    // repo A must never be reported as "existing" for PR #42 in repo B.
    insertTask(getDb(), {
      id: 'review-in-repo-a',
      repo_path: '/repo/a',
      pr_number: 42,
      source: 'auto_review',
      runtime_state: 'running',
    });
    const sourceTaskInRepoB = insertTask(getDb(), {
      id: 'source-in-repo-b',
      repo_path: '/repo/b',
      pr_number: 42,
    });

    const result = lookupExistingReviewId(sourceTaskInRepoB);

    expect(result).toBeNull();
  });

  it('matches a review task for the same repo + PR number', () => {
    insertTask(getDb(), {
      id: 'review-in-repo-a',
      repo_path: '/repo/a',
      pr_number: 42,
      source: 'auto_review',
      runtime_state: 'running',
    });
    const sourceTaskInRepoA = insertTask(getDb(), {
      id: 'source-in-repo-a',
      repo_path: '/repo/a',
      pr_number: 42,
    });

    const result = lookupExistingReviewId(sourceTaskInRepoA);

    expect(result).toBe('review-in-repo-a');
  });
});

describe('validateCreateTaskBody — compute', () => {
  const baseBody = { title: 't', description: 'd', repo_path: '/repo/a' };

  it('accepts an omitted compute field', () => {
    const result = validateCreateTaskBody(baseBody, 'new');
    expect(result).toBeNull();
  });

  it('accepts a known compute kind', () => {
    const result = validateCreateTaskBody({ ...baseBody, compute: CORE_COMPUTE_KINDS[0] }, 'new');
    expect(result).toBeNull();
  });

  it('rejects an unknown compute kind with a 400', () => {
    const result = validateCreateTaskBody({ ...baseBody, compute: 'bogus-compute' }, 'new');
    expect(result?.status).toBe(400);
    expect(result?.message).toMatch(/bogus-compute/);
  });
});
