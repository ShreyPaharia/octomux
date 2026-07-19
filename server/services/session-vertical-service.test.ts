import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunAgentSession = vi.fn();
const mockGetHarness = vi.fn();

vi.mock('../agent-session/session.js', () => ({
  runAgentSession: (...args: unknown[]) => mockRunAgentSession(...args),
}));
vi.mock('../agent-session/substrate-pty.js', () => ({
  ptySubstrate: { kind: 'pty', name: 'stub-pty-substrate' },
}));
vi.mock('../harnesses/registry.js', () => ({
  getHarness: (...args: unknown[]) => mockGetHarness(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runSessionVertical } from './session-vertical-service.js';

describe('runSessionVertical', () => {
  beforeEach(() => {
    mockRunAgentSession.mockReset();
    mockGetHarness.mockReset();
  });

  it('wires harness/substrate/run and returns the result', async () => {
    const stubHarness = { id: 'claude-code' };
    mockGetHarness.mockReturnValue(stubHarness);
    mockRunAgentSession.mockResolvedValue({ result: { summary: 'ok' } });

    const outputSchema = { type: 'object' };
    const { result } = await runSessionVertical({
      kind: 'overnight-log-summary',
      scheduleId: 'sched-1',
      workspaceDir: '/repo',
      input: 'do the thing',
      outputSchema,
      model: 'claude-opus-4-8',
    });

    expect(result).toEqual({ summary: 'ok' });
    expect(mockGetHarness).toHaveBeenCalledWith(null);
    expect(mockRunAgentSession).toHaveBeenCalledTimes(1);
    const call = mockRunAgentSession.mock.calls[0][0];
    expect(call.workspaceDir).toBe('/repo');
    expect(call.harness).toBe(stubHarness);
    expect(call.input).toBe('do the thing');
    expect(call.substrate).toEqual({ kind: 'pty', name: 'stub-pty-substrate' });
    expect(call.outputSchema).toBe(outputSchema);
    expect(call.model).toBe('claude-opus-4-8');
    expect(call.run).toEqual({
      workflowKind: 'overnight-log-summary',
      trigger: 'cron',
      scheduleId: 'sched-1',
    });
  });

  it('defaults model to null and scheduleId to undefined when omitted', async () => {
    mockGetHarness.mockReturnValue({ id: 'claude-code' });
    mockRunAgentSession.mockResolvedValue({ result: {} });

    await runSessionVertical({
      kind: 'overnight-log-summary',
      workspaceDir: '/repo',
      input: 'x',
      outputSchema: {},
    });

    const call = mockRunAgentSession.mock.calls[0][0];
    expect(call.model).toBeNull();
    expect(call.run.scheduleId).toBeUndefined();
  });
});
