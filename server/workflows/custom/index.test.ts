import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listCronWorkflowKinds } from '../registry.js';

const mockRunCustom = vi.fn().mockResolvedValue(undefined);

vi.mock('./run.js', () => ({
  runCustom: (...args: unknown[]) => mockRunCustom(...args),
}));

import './index.js';

describe('custom workflow registration', () => {
  beforeEach(() => {
    mockRunCustom.mockClear();
  });

  it('registers the custom kind in the workflow registry', () => {
    const wf = getWorkflow('custom');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Custom Prompt');
    expect(wf?.surfaces).toEqual(['artifact']);
    expect(wf?.execution).toBe('session');
    expect(wf?.trigger).toEqual({ kind: 'cron' });
    expect(wf?.run).toBeTypeOf('function');
  });

  it('appears in listCronWorkflowKinds()', () => {
    const kinds = listCronWorkflowKinds();
    expect(kinds).toContain('custom');
  });

  it('has no config schema (custom kind has no structured config in v1)', () => {
    const wf = getWorkflow('custom')!;
    expect(wf.config).toBeUndefined();
  });

  it('calls runCustom with the context fields and returns immediately (fire-and-forget)', async () => {
    const wf = getWorkflow('custom')!;
    const result = wf.run!({
      repoPath: '/repo',
      config: {},
      scheduleId: 'sched-123',
      model: 'claude-opus-4-8',
      timeoutMs: 60000,
      trigger: 'manual',
    });

    // The run() function returns Promise.resolve() immediately without awaiting runCustom
    await result;

    // Allow the void promise chain to flush
    await Promise.resolve();

    expect(mockRunCustom).toHaveBeenCalledTimes(1);
    expect(mockRunCustom).toHaveBeenCalledWith({
      repoPath: '/repo',
      scheduleId: 'sched-123',
      model: 'claude-opus-4-8',
      timeoutMs: 60000,
      trigger: 'manual',
    });
  });

  it('passes empty string scheduleId when ctx.scheduleId is undefined', async () => {
    const wf = getWorkflow('custom')!;
    await wf.run!({
      repoPath: '/repo',
      config: {},
    });
    await Promise.resolve();

    expect(mockRunCustom).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: '' }));
  });
});
