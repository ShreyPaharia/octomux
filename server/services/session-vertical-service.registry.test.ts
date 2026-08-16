/**
 * Proves `runSessionVertical` resolves a real harness via the barrel even
 * when the harness registry starts empty — no mock on `harnesses/registry.js`
 * or `harnesses/index.js`. Before the fix, `session-vertical-service.ts`
 * imported the bare `registry.js`, which stays empty unless some other
 * module's side-effect import populated it first, so `getHarness(null)`
 * threw `Unknown harness: claude-code` whenever this module happened to be
 * the first to touch harnesses in the process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from '../bun-test.js';
import { resetHarnesses, getHarness } from '../harnesses/registry.js';

const mockRunAgentSession = vi.fn();

vi.mock('../agent-session/session.js', () => ({
  runAgentSession: (...args: unknown[]) => mockRunAgentSession(...args),
}));
vi.mock('../agent-session/substrate-pty.js', () => ({
  ptySubstrate: { kind: 'pty', name: 'stub-pty-substrate' },
}));

const { runSessionVertical } = await import('./session-vertical-service.js');

describe('runSessionVertical resolves the harness via the barrel', () => {
  beforeEach(() => {
    mockRunAgentSession.mockReset();
    // Empty, real registry — nothing in this test has loaded the harnesses
    // barrel yet.
    resetHarnesses();
  });

  afterEach(() => {
    resetHarnesses();
  });

  it('finds claude-code even when the registry started empty', async () => {
    mockRunAgentSession.mockResolvedValue({ result: { ok: true } });

    await runSessionVertical({
      kind: 'overnight-log-summary',
      workspaceDir: '/repo',
      input: 'do the thing',
      outputSchema: {},
    });

    expect(mockRunAgentSession).toHaveBeenCalledTimes(1);
    const call = mockRunAgentSession.mock.calls[0][0];
    expect(call.harness.id).toBe('claude-code');
    // Confirms the real barrel ran, not a leftover from some other test's
    // registration: the registry now really has claude-code in it.
    expect(getHarness('claude-code').id).toBe('claude-code');
  });
});
