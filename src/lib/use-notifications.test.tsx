import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useNotifications } from './use-notifications';
import { makeTask, makeAgent } from '../test-helpers';

vi.mock('../components/CustomToast', () => ({
  showToast: vi.fn(),
  CustomToast: vi.fn(),
}));

const { showToast } = await import('../components/CustomToast');

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

const navigate = vi.fn();

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  navigate.mockClear();
  localStorage.clear();
});

describe('useNotifications', () => {
  it('does not fire any toasts on first load with running tasks', () => {
    const tasks = [
      makeTask({
        id: 't1',
        title: 'Task one',
        runtime_state: 'running',
        agents: [
          makeAgent({ id: 'a1', task_id: 't1', status: 'running', hook_activity: 'active' }),
        ],
      }),
    ];
    renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: tasks },
      wrapper,
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not fire "Task closed" for tasks that were already closed when the page loaded', () => {
    const closedTasks = [
      makeTask({
        id: 't1',
        title: 'Task one',
        runtime_state: 'idle',
        agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'stopped', hook_activity: 'idle' })],
      }),
      makeTask({
        id: 't2',
        title: 'Task two',
        runtime_state: 'idle',
        agents: [makeAgent({ id: 'a2', task_id: 't2', status: 'stopped', hook_activity: 'idle' })],
      }),
    ];
    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: closedTasks },
      wrapper,
    });

    // Simulate an unrelated update — same tasks, same state.
    rerender({ t: [...closedTasks] });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('fires "Task closed" once when a running task transitions to idle', () => {
    const running = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'running',
      agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'running', hook_activity: 'active' })],
    });
    const closed = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'idle',
      agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'stopped', hook_activity: 'idle' })],
    });
    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: [running] },
      wrapper,
    });

    rerender({ t: [closed] });

    const calls = vi.mocked(showToast).mock.calls;
    const closeCalls = calls.filter((c) => c[2] === 'Task closed');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0][1]).toBe('Task one');

    // Subsequent identical refresh should not re-fire.
    vi.mocked(showToast).mockClear();
    rerender({ t: [closed] });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('fires "Task errored" once when a running task transitions to error', () => {
    const running = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'running',
      agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'running', hook_activity: 'active' })],
    });
    const errored = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'error',
      error: 'boom',
      agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'stopped', hook_activity: 'idle' })],
    });
    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: [running] },
      wrapper,
    });

    rerender({ t: [errored] });

    const calls = vi.mocked(showToast).mock.calls;
    const errorCalls = calls.filter((c) => c[2] === 'Task errored');
    expect(errorCalls).toHaveLength(1);
  });

  it('suppresses per-agent "Agent stopped" toasts when the whole task is closing', () => {
    const running = makeTask({
      id: 't1',
      title: 'Multi agent',
      runtime_state: 'running',
      agents: [
        makeAgent({
          id: 'a1',
          task_id: 't1',
          label: 'Agent 1',
          status: 'running',
          hook_activity: 'active',
        }),
        makeAgent({
          id: 'a2',
          task_id: 't1',
          label: 'Agent 2',
          status: 'running',
          hook_activity: 'active',
        }),
        makeAgent({
          id: 'a3',
          task_id: 't1',
          label: 'Agent 3',
          status: 'running',
          hook_activity: 'active',
        }),
      ],
    });
    const closed = makeTask({
      id: 't1',
      title: 'Multi agent',
      runtime_state: 'idle',
      agents: [
        makeAgent({
          id: 'a1',
          task_id: 't1',
          label: 'Agent 1',
          status: 'stopped',
          hook_activity: 'idle',
        }),
        makeAgent({
          id: 'a2',
          task_id: 't1',
          label: 'Agent 2',
          status: 'stopped',
          hook_activity: 'idle',
        }),
        makeAgent({
          id: 'a3',
          task_id: 't1',
          label: 'Agent 3',
          status: 'stopped',
          hook_activity: 'idle',
        }),
      ],
    });

    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: [running] },
      wrapper,
    });
    rerender({ t: [closed] });

    const calls = vi.mocked(showToast).mock.calls;
    expect(calls.filter((c) => c[2] === 'Agent stopped')).toHaveLength(0);
    expect(calls.filter((c) => c[2] === 'Agent finished')).toHaveLength(0);
    expect(calls.filter((c) => c[2] === 'Task closed')).toHaveLength(1);
  });

  it('still fires "Agent stopped" when a single agent stops inside a still-running task', () => {
    const before = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'running',
      agents: [
        makeAgent({
          id: 'a1',
          task_id: 't1',
          label: 'Agent 1',
          status: 'running',
          hook_activity: 'active',
        }),
        makeAgent({
          id: 'a2',
          task_id: 't1',
          label: 'Agent 2',
          status: 'running',
          hook_activity: 'active',
        }),
      ],
    });
    const oneStopped = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'running',
      agents: [
        makeAgent({
          id: 'a1',
          task_id: 't1',
          label: 'Agent 1',
          status: 'stopped',
          hook_activity: 'idle',
        }),
        makeAgent({
          id: 'a2',
          task_id: 't1',
          label: 'Agent 2',
          status: 'running',
          hook_activity: 'active',
        }),
      ],
    });

    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: [before] },
      wrapper,
    });
    rerender({ t: [oneStopped] });

    const calls = vi.mocked(showToast).mock.calls;
    expect(calls.filter((c) => c[2] === 'Agent stopped')).toHaveLength(1);
    expect(calls.filter((c) => c[2] === 'Task closed')).toHaveLength(0);
  });

  it('fires permission prompt toast for newly created pending prompts', () => {
    const initial = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'running',
      agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'running', hook_activity: 'active' })],
      pending_prompts: [],
    });
    const withPrompt = makeTask({
      id: 't1',
      title: 'Task one',
      runtime_state: 'running',
      agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'running', hook_activity: 'waiting' })],
      pending_prompts: [
        {
          id: 'p1',
          task_id: 't1',
          agent_id: 'a1',
          agent_label: 'Agent 1',
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: {},
          status: 'pending',
          created_at: '2026-01-01 00:00:00',
          resolved_at: null,
        },
      ],
    });

    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: [initial] },
      wrapper,
    });
    rerender({ t: [withPrompt] });

    const calls = vi.mocked(showToast).mock.calls;
    const promptCalls = calls.filter((c) => String(c[2]).startsWith('Needs permission'));
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0][2]).toBe('Needs permission: Bash');
  });

  it('does not fire "Task closed" for an already-idle task whose agent row is stuck at status=running', () => {
    // Stale-data scenario found in production: task.runtime_state='idle' but
    // the agent row still has status='running' (cleanup was missed at some
    // point — e.g. server crash mid-close). Previously the transition
    // detector inferred "task was running" from agent.status, so every WS
    // refresh re-fired "Task closed". The detector now compares the task's
    // previous runtime_state instead, so an already-idle task stays quiet.
    const stale = makeTask({
      id: 't1',
      title: 'Stuck task',
      runtime_state: 'idle',
      agents: [makeAgent({ id: 'a1', task_id: 't1', status: 'running', hook_activity: 'idle' })],
    });
    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: [stale] },
      wrapper,
    });

    // Three WS-triggered refreshes with no real change — only updated_at jitters.
    rerender({ t: [{ ...stale, updated_at: '2026-01-02' }] });
    rerender({ t: [{ ...stale, updated_at: '2026-01-03' }] });
    rerender({ t: [{ ...stale, updated_at: '2026-01-04' }] });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not re-fire permission prompt toasts for prompts already present at load time', () => {
    const tasks = [
      makeTask({
        id: 't1',
        title: 'Task one',
        runtime_state: 'running',
        agents: [
          makeAgent({ id: 'a1', task_id: 't1', status: 'running', hook_activity: 'waiting' }),
        ],
        pending_prompts: [
          {
            id: 'p1',
            task_id: 't1',
            agent_id: 'a1',
            agent_label: 'Agent 1',
            session_id: 's1',
            tool_name: 'Bash',
            tool_input: {},
            status: 'pending',
            created_at: '2026-01-01 00:00:00',
            resolved_at: null,
          },
        ],
      }),
    ];
    const { rerender } = renderHook(({ t }) => useNotifications(t, navigate), {
      initialProps: { t: tasks },
      wrapper,
    });
    rerender({ t: [...tasks] });

    expect(showToast).not.toHaveBeenCalled();
  });
});
