import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';

const mockGetSkill = vi.fn();
const mockRunSessionVertical = vi.fn();

vi.mock('../../skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));
vi.mock('../../services/session-vertical-service.js', () => ({
  runSessionVertical: (...args: unknown[]) => mockRunSessionVertical(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runOvernightLogSummary } from './run.js';
import { OVERNIGHT_LOG_SUMMARY_SCHEMA } from './schema.js';

describe('runOvernightLogSummary', () => {
  beforeEach(() => {
    createTestDb();
    mockGetSkill.mockReset();
    mockRunSessionVertical.mockReset();
  });

  it('loads the skill, interpolates logCommand/repoShort, and calls runSessionVertical', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'overnight-log-summary',
      content: 'Run {{logCommand}} for {{repoShort}}.',
    });
    mockRunSessionVertical.mockResolvedValue({ result: { summary: 'ok' } });

    const { result } = await runOvernightLogSummary({
      repoPath: '/repos/My App',
      scheduleId: 'sched-1',
      logCommand: 'gh run list --limit 30',
    });

    expect(result).toEqual({ summary: 'ok' });
    // The DB is the source of truth now — the prompt seeds from the shipped
    // SKILL.md (no repo override).
    expect(mockGetSkill).toHaveBeenCalledWith('overnight-log-summary');
    expect(mockRunSessionVertical).toHaveBeenCalledTimes(1);
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('overnight-log-summary');
    expect(call.scheduleId).toBe('sched-1');
    expect(call.workspaceDir).toBe('/repos/My App');
    expect(call.input).toBe('Run gh run list --limit 30 for my-app.');
    expect(call.outputSchema).toBe(OVERNIGHT_LOG_SUMMARY_SCHEMA);
  });

  it('leaves unknown {{tokens}} intact in the interpolated prompt', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'overnight-log-summary',
      content: 'Run {{logCommand}} {{unknownToken}} for {{repoShort}}.',
    });
    mockRunSessionVertical.mockResolvedValue({ result: { summary: 'ok' } });

    await runOvernightLogSummary({
      repoPath: '/repos/My App',
      scheduleId: 'sched-2',
      logCommand: 'gh run list',
    });

    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.input).toBe('Run gh run list {{unknownToken}} for my-app.');
  });

  it('passes model and timeoutMs through to runSessionVertical', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'overnight-log-summary',
      content: 'Run {{logCommand}} for {{repoShort}}.',
    });
    mockRunSessionVertical.mockResolvedValue({ result: { summary: 'ok' } });

    await runOvernightLogSummary({
      repoPath: '/repos/My App',
      scheduleId: 'sched-3',
      logCommand: 'gh run list --limit 30',
      model: 'claude-haiku-4-5-20251001',
      timeoutMs: 600000,
    });

    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.timeoutMs).toBe(600000);
  });

  it('passes undefined model/timeoutMs when not specified', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'overnight-log-summary',
      content: 'Run {{logCommand}} for {{repoShort}}.',
    });
    mockRunSessionVertical.mockResolvedValue({ result: { summary: 'ok' } });

    await runOvernightLogSummary({
      repoPath: '/repos/My App',
      scheduleId: 'sched-4',
      logCommand: 'gh run list --limit 30',
    });

    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.model).toBeUndefined();
    expect(call.timeoutMs).toBeUndefined();
  });
});
