/**
 * B5: Tests for server/title-gen.ts
 *
 * Covers: empty-prompt fallback, CLI error fallback, success path, invalid JSON fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findCallback } from './test-helpers.js';

// ─── child_process mock ──────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = findCallback(..._args);
    if (cb) cb(null, { stdout: '', stderr: '' });
    return undefined as never;
  }),
}));

import { generateTitleAndDescription } from './title-gen.js';
import { execFile } from 'child_process';
const mockedExecFile = vi.mocked(execFile);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_PROMPT = 'Add an archive button to the task board so old tasks can be hidden';

function mockClaudeOk(stdout: string) {
  mockedExecFile.mockImplementationOnce(((...args: unknown[]) => {
    const cb = findCallback(...args);
    if (cb) cb(null, { stdout, stderr: '' });
    return undefined as never;
  }) as never);
}

function mockClaudeFail(err: Error) {
  mockedExecFile.mockImplementationOnce(((...args: unknown[]) => {
    const cb = findCallback(...args);
    if (cb) cb(err);
    return undefined as never;
  }) as never);
}

function jsonResponse(title: string, description: string): string {
  return JSON.stringify({ title, description });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('generateTitleAndDescription (B5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to first-line truncation when prompt is empty', async () => {
    const result = await generateTitleAndDescription('');
    expect(result.title).toBe('Untitled task');
    expect(result.description).toBe('');
    const claudeCalls = mockedExecFile.mock.calls.filter((c) => c[0] === 'claude');
    expect(claudeCalls).toHaveLength(0);
  });

  it('returns generated title and description on success', async () => {
    mockClaudeOk(jsonResponse('Add Archive Button', 'Add an archive button to hide old tasks.'));

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title).toBe('Add Archive Button');
    expect(result.description).toBe('Add an archive button to hide old tasks.');
  });

  it('truncates title to 50 chars on success', async () => {
    mockClaudeOk(jsonResponse('A'.repeat(100), 'Description here.'));

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title.length).toBeLessThanOrEqual(50);
  });

  it('falls back when CLI throws an error', async () => {
    mockClaudeFail(new Error('claude not found'));

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title).toBe(SAMPLE_PROMPT.slice(0, 80));
    expect(result.description).toBe(SAMPLE_PROMPT);
  });

  it('falls back when CLI returns invalid JSON', async () => {
    mockClaudeOk('not valid json');

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title).toBe(SAMPLE_PROMPT.slice(0, 80));
  });

  it('passes haiku flags to claude -p', async () => {
    mockClaudeOk(jsonResponse('Add X', 'Adds X.'));

    await generateTitleAndDescription(SAMPLE_PROMPT);

    const claudeCalls = mockedExecFile.mock.calls.filter((c) => c[0] === 'claude');
    expect(claudeCalls).toHaveLength(1);
    const args = claudeCalls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--model');
    expect(args).toContain('haiku');
    expect(args).toContain('--tools');
    expect(args).toContain('--no-session-persistence');
    const promptArg = args[args.length - 1];
    expect(promptArg).toContain(SAMPLE_PROMPT);
  });
});
