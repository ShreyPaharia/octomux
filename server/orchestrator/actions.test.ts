/**
 * server/orchestrator/actions.test.ts
 *
 * Unit tests for the orchestrator write-action dispatcher (SHR-142). exec.ts and
 * stream.ts are mocked so we test the dispatch + activity-push logic without
 * tmux/worktrees.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRunCreateTask = vi.fn().mockResolvedValue({ task_id: 't-new', title: 'New Task' });
const mockRunSendMessage = vi.fn().mockResolvedValue(undefined);
const mockRunAddAgent = vi.fn().mockResolvedValue({ agent_id: 'a-new', window_index: 2 });
const mockRunSetStatus = vi.fn().mockResolvedValue(undefined);
const mockRunCloseTask = vi.fn().mockResolvedValue(undefined);
const mockRunResumeTask = vi.fn().mockResolvedValue(undefined);
const mockRunDeleteTask = vi.fn().mockResolvedValue(undefined);

vi.mock('./exec.js', () => ({
  runCreateTask: (...a: unknown[]) => mockRunCreateTask(...a),
  runSendMessage: (...a: unknown[]) => mockRunSendMessage(...a),
  runAddAgent: (...a: unknown[]) => mockRunAddAgent(...a),
  runSetStatus: (...a: unknown[]) => mockRunSetStatus(...a),
  runCloseTask: (...a: unknown[]) => mockRunCloseTask(...a),
  runResumeTask: (...a: unknown[]) => mockRunResumeTask(...a),
  runDeleteTask: (...a: unknown[]) => mockRunDeleteTask(...a),
}));

const mockPush = vi.fn();
vi.mock('./stream.js', () => ({
  pushToConversation: (...a: unknown[]) => mockPush(...a),
}));

import { runOrchestratorAction, ORCHESTRATOR_ACTIONS } from './actions.js';

describe('runOrchestratorAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create-task: forwards structured args + conversation_id and pushes an activity receipt', async () => {
    const result = await runOrchestratorAction('conv-1', 'create-task', {
      title: 'Do the thing',
      description: '## Goal\nx',
      repo_path: '/tmp/repo',
      base_branch: 'next',
      kind: 'plan',
    });

    expect(mockRunCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Do the thing',
        description: '## Goal\nx',
        // The brief (description) becomes the worker's prompt — else the worker
        // launches with no prompt and does nothing.
        initial_prompt: '## Goal\nx',
        repo_path: '/tmp/repo', // structured — no string parsing
        base_branch: 'next',
        kind: 'plan',
        conversation_id: 'conv-1',
      }),
    );
    expect(result).toEqual({ task_id: 't-new', title: 'New Task' });
    // Activity receipt pushed to the conversation.
    const pushed = mockPush.mock.calls.map((c) => String(c[1]));
    expect(pushed.some((m) => /created task/i.test(m) && m.includes('t-new'))).toBe(true);
  });

  it('accepts camelCase aliases (repoPath, initialPrompt)', async () => {
    await runOrchestratorAction('conv-1', 'create-task', {
      title: 'T',
      description: 'd',
      repoPath: '/tmp/repo2',
      initialPrompt: 'go',
    });
    expect(mockRunCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ repo_path: '/tmp/repo2', initial_prompt: 'go' }),
    );
  });

  it('send-message: requires task_id and message', async () => {
    await runOrchestratorAction('conv-1', 'send-message', { task_id: 't1', message: 'hi' });
    expect(mockRunSendMessage).toHaveBeenCalledWith('t1', 'hi');

    await expect(
      runOrchestratorAction('conv-1', 'send-message', { task_id: 't1' }),
    ).rejects.toThrow(/message/i);
    await expect(
      runOrchestratorAction('conv-1', 'send-message', { message: 'hi' }),
    ).rejects.toThrow(/task_id/i);
  });

  it('delete-task runs immediately (no approval) and reports it', async () => {
    await runOrchestratorAction('conv-1', 'delete-task', { task_id: 't9' });
    expect(mockRunDeleteTask).toHaveBeenCalledWith('t9');
    const pushed = mockPush.mock.calls.map((c) => String(c[1]));
    expect(pushed.some((m) => /deleted task/i.test(m))).toBe(true);
  });

  it('runs the action even without a conversation (no card, no managed task)', async () => {
    const result = await runOrchestratorAction(undefined, 'create-task', {
      title: 'T',
      description: 'd',
      repo_path: '/tmp/r',
    });
    expect(mockRunCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: undefined }),
    );
    expect(result).toBeTruthy();
  });

  it('ORCHESTRATOR_ACTIONS lists the supported actions', () => {
    expect(ORCHESTRATOR_ACTIONS.has('create-task')).toBe(true);
    expect(ORCHESTRATOR_ACTIONS.has('delete-task')).toBe(true);
    expect(ORCHESTRATOR_ACTIONS.has('bogus')).toBe(false);
  });
});
