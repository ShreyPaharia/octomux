import { describe, it, expect, vi, beforeEach } from '../bun-test.js';
import type { PolicyIntent } from '@octomux/plugin-api';

// Mock factories must be synchronous (they are here) and registered BEFORE the
// module under test is imported — `vi.mock()` maps to bun's `mock.module()`,
// which does not hoist, unlike vitest's.
vi.mock('./facts.js', () => ({
  putCoreFact: vi.fn(async () => undefined),
}));
vi.mock('../repositories/tasks.js', () => ({
  addTaskUpdate: vi.fn(() => 'update-id'),
}));

const { putCoreFact } = await import('./facts.js');
const { addTaskUpdate } = await import('../repositories/tasks.js');
const {
  registerPolicyHook,
  unregisterPluginPolicy,
  policyHookCounts,
  evaluatePolicy,
  enforcePolicy,
  resetPolicy,
  POLICY_HOOK_TIMEOUT_MS,
} = await import('./policy.js');

const mockedPutCoreFact = vi.mocked(putCoreFact);
const mockedAddTaskUpdate = vi.mocked(addTaskUpdate);

describe('plugins/policy', () => {
  beforeEach(() => {
    resetPolicy();
    mockedPutCoreFact.mockClear();
    mockedAddTaskUpdate.mockClear();
  });

  it('fast path: no hooks registered for the point allows through untouched, no recording', async () => {
    const data = { harnessId: 'claude-code' };
    const outcome = await evaluatePolicy('task.launch', { taskId: 'task-1', data });

    expect(outcome).toEqual({ allowed: true, data });
    expect(mockedPutCoreFact).not.toHaveBeenCalled();
    expect(mockedAddTaskUpdate).not.toHaveBeenCalled();
  });

  it('a hook returning undefined is "no opinion" — allows through, nothing recorded', async () => {
    registerPolicyHook('noop-bot', 'task.launch', () => undefined);
    const outcome = await evaluatePolicy('task.launch', {
      taskId: 'task-1',
      data: { model: 'sonnet' },
    });

    expect(outcome).toEqual({ allowed: true, data: { model: 'sonnet' } });
    expect(mockedPutCoreFact).not.toHaveBeenCalled();
    expect(mockedAddTaskUpdate).not.toHaveBeenCalled();
  });

  it('a deny short-circuits, records the fact + task update, and later hooks never run', async () => {
    const secondHook = vi.fn(() => undefined);
    registerPolicyHook('spend-cap', 'task.launch', () => ({ deny: 'over budget' }));
    registerPolicyHook('other-bot', 'task.launch', secondHook);

    const outcome = await evaluatePolicy('task.launch', { taskId: 'task-1', data: {} });

    expect(outcome).toEqual({ allowed: false, reason: 'over budget', pluginId: 'spend-cap' });
    expect(secondHook).not.toHaveBeenCalled();
    expect(mockedPutCoreFact).toHaveBeenCalledWith(
      'task-1',
      'core:policy.decision',
      expect.objectContaining({ point: 'task.launch', pluginId: 'spend-cap', decision: 'deny' }),
    );
    expect(mockedAddTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        kind: 'policy',
        body: expect.stringContaining('spend-cap'),
      }),
    );
  });

  it('a deny with a non-string/empty reason is synthesised, never treated as allow', async () => {
    registerPolicyHook('sloppy-bot', 'task.launch', () => ({ deny: '' }) as never);

    const outcome = await evaluatePolicy('task.launch', { taskId: 'task-1', data: {} });

    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.reason).toContain('sloppy-bot');
      expect(outcome.pluginId).toBe('sloppy-bot');
    }
  });

  it('a patch merges into data and the next hook sees the patched value', async () => {
    registerPolicyHook('rewriter', 'task.launch', () => ({ patch: { model: 'haiku' } }));
    let seenModel: unknown;
    registerPolicyHook('observer', 'task.launch', (intent: PolicyIntent) => {
      seenModel = intent.data.model;
      return undefined;
    });

    const outcome = await evaluatePolicy('task.launch', {
      taskId: 'task-1',
      data: { model: 'sonnet' },
    });

    expect(outcome).toEqual({ allowed: true, data: { model: 'haiku' } });
    expect(seenModel).toBe('haiku');
    expect(mockedPutCoreFact).toHaveBeenCalledWith(
      'task-1',
      'core:policy.decision',
      expect.objectContaining({ point: 'task.launch', pluginId: 'rewriter', decision: 'patch' }),
    );
    expect(mockedAddTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: 'task-1', kind: 'policy' }),
    );
  });

  it('recording is skipped entirely when the intent has no taskId', async () => {
    registerPolicyHook('spend-cap', 'task.launch', () => ({ deny: 'nope' }));

    const outcome = await evaluatePolicy('task.launch', { data: {} });

    expect(outcome).toEqual({ allowed: false, reason: 'nope', pluginId: 'spend-cap' });
    expect(mockedPutCoreFact).not.toHaveBeenCalled();
    expect(mockedAddTaskUpdate).not.toHaveBeenCalled();
  });

  it('a hook that throws is logged and treated as no opinion (fail open)', async () => {
    registerPolicyHook('crashy-bot', 'task.launch', () => {
      throw new Error('boom');
    });
    const secondHook = vi.fn(() => undefined);
    registerPolicyHook('after-crash', 'task.launch', secondHook);

    const outcome = await evaluatePolicy('task.launch', { taskId: 'task-1', data: {} });

    expect(outcome).toEqual({ allowed: true, data: {} });
    expect(secondHook).toHaveBeenCalled();
    expect(mockedPutCoreFact).not.toHaveBeenCalled();
  });

  it(
    'a hook that outruns POLICY_HOOK_TIMEOUT_MS is treated as no opinion (fail open)',
    async () => {
      registerPolicyHook(
        'slow-bot',
        'task.launch',
        () => new Promise(() => {}), // never resolves
      );

      const outcome = await evaluatePolicy('task.launch', { taskId: 'task-1', data: {} });

      expect(outcome).toEqual({ allowed: true, data: {} });
    },
    POLICY_HOOK_TIMEOUT_MS + 5000,
  );

  it('enforcePolicy returns the patched data on allow', async () => {
    registerPolicyHook('rewriter', 'harness.resume', () => ({ patch: { model: 'haiku' } }));

    const data = await enforcePolicy('harness.resume', {
      taskId: 'task-1',
      data: { model: 'sonnet' },
    });

    expect(data).toEqual({ model: 'haiku' });
  });

  it('enforcePolicy throws a message naming the plugin and reason on deny', async () => {
    registerPolicyHook('spend-cap', 'harness.resume', () => ({ deny: 'over budget' }));

    await expect(enforcePolicy('harness.resume', { taskId: 'task-1', data: {} })).rejects.toThrow(
      /policy denied harness\.resume.*spend-cap.*over budget/,
    );
  });

  it("unregisterPluginPolicy removes only the named plugin's hooks and returns the count", async () => {
    registerPolicyHook('bot-a', 'task.launch', () => undefined);
    registerPolicyHook('bot-a', 'review.publish', () => undefined);
    registerPolicyHook('bot-b', 'task.launch', () => ({ deny: 'still here' }));

    const removed = unregisterPluginPolicy('bot-a');
    expect(removed).toBe(2);

    const outcome = await evaluatePolicy('task.launch', { taskId: 'task-1', data: {} });
    expect(outcome).toEqual({ allowed: false, reason: 'still here', pluginId: 'bot-b' });

    // task.launch's map entry no longer references bot-a but bot-b's hook still runs;
    // review.publish had only bot-a, so it's back on the fast path.
    const reviewOutcome = await evaluatePolicy('review.publish', { taskId: 'task-1', data: {} });
    expect(reviewOutcome).toEqual({ allowed: true, data: {} });
  });

  it('unregisterPluginPolicy on a plugin with no hooks removes nothing', () => {
    expect(unregisterPluginPolicy('never-registered')).toBe(0);
  });

  it('policyHookCounts tallies hooks per plugin across every point', () => {
    registerPolicyHook('bot-a', 'task.launch', () => undefined);
    registerPolicyHook('bot-a', 'review.publish', () => undefined);
    registerPolicyHook('bot-b', 'task.launch', () => undefined);

    expect(policyHookCounts()).toEqual({ 'bot-a': 2, 'bot-b': 1 });
  });

  it('resetPolicy clears every registered hook', async () => {
    registerPolicyHook('bot-a', 'task.launch', () => ({ deny: 'no' }));
    resetPolicy();

    const outcome = await evaluatePolicy('task.launch', { taskId: 'task-1', data: {} });
    expect(outcome).toEqual({ allowed: true, data: {} });
  });
});
