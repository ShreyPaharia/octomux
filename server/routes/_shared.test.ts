import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolveAiTaskNamingEnabled reads settings.js's getSettings() when
// OCTOMUX_AI_TASK_NAMING is unset — stub it so tests control the resolution
// order without touching the real filesystem.
const mockGetSettings = vi.fn(async () => ({}) as { aiTaskNaming?: boolean });
vi.mock('../settings.js', () => ({ getSettings: () => mockGetSettings() }));

// title-gen.js shells out to the Claude CLI — never invoked by these tests
// (aiTaskNamingEnabled is what's under test, not the polish call itself),
// but must not blow up module resolution.
vi.mock('../title-gen.js', () => ({ generateTitleAndDescription: vi.fn() }));

import { resolveAiTaskNamingEnabled } from './_shared.js';

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
