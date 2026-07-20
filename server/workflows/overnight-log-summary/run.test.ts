import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    expect(mockGetSkill).toHaveBeenCalledWith('overnight-log-summary', {
      repoPath: '/repos/My App',
    });
    expect(mockRunSessionVertical).toHaveBeenCalledTimes(1);
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('overnight-log-summary');
    expect(call.scheduleId).toBe('sched-1');
    expect(call.workspaceDir).toBe('/repos/My App');
    expect(call.input).toBe('Run gh run list --limit 30 for my-app.');
    expect(call.outputSchema).toBe(OVERNIGHT_LOG_SUMMARY_SCHEMA);
  });
});
