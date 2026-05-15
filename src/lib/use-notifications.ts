import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { Task, Agent } from '../../server/types';
import { showToast } from '../components/CustomToast';
import { getNotificationsEnabled } from './notification-settings';

interface AgentSnapshot {
  status: Agent['status'];
  hookActivity: Agent['hook_activity'];
}

/** Format: "Task Title #1" — extracts number from agent label like "Agent 1". */
function agentTag(task: Task, agent: Agent): string {
  const num = agent.label.match(/\d+/)?.[0] ?? '1';
  return `${task.title} #${num}`;
}

/** Returns the task ID from the current URL if on a task detail page. */
function useViewingTaskId(): string | null {
  const { pathname } = useLocation();
  const match = pathname.match(/^\/tasks\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Watches tasks for agent state transitions and fires toast notifications.
 * Suppresses notifications for the task the user is currently viewing.
 */
export function useNotifications(tasks: Task[], navigate: (path: string) => void) {
  const prevAgents = useRef<Map<string, AgentSnapshot>>(new Map());
  const notifiedPrompts = useRef<Set<string>>(new Set());
  const initialized = useRef(false);
  const viewingTaskId = useViewingTaskId();

  useEffect(() => {
    if (!getNotificationsEnabled()) return;
    if (tasks.length === 0) return;

    const currentAgents = new Map<string, AgentSnapshot>();
    // Tasks transitioning to closed/error this tick. We pre-compute this so
    // we can suppress redundant per-agent toasts below — a single "Task closed"
    // is clearer than N "Agent stopped" toasts saying the same thing.
    const taskTransitioning = new Set<string>();
    if (initialized.current) {
      for (const task of tasks) {
        if (task.id === viewingTaskId) continue;
        if (task.runtime_state !== 'idle' && task.runtime_state !== 'error') continue;
        const hadActiveAgents = task.agents?.some((a) => {
          const prev = prevAgents.current.get(a.id);
          return prev && prev.status !== 'stopped';
        });
        if (hadActiveAgents) taskTransitioning.add(task.id);
      }
    }

    for (const task of tasks) {
      if (!task.agents) continue;

      const isViewing = task.id === viewingTaskId;
      const suppressAgentToasts = taskTransitioning.has(task.id);

      for (const agent of task.agents) {
        currentAgents.set(agent.id, {
          status: agent.status,
          hookActivity: agent.hook_activity,
        });

        // Skip notifications on first load to avoid spamming existing state
        if (!initialized.current) continue;

        const prev = prevAgents.current.get(agent.id);
        if (!prev) continue;

        // Skip notifications for the task the user is currently viewing
        if (isViewing) continue;

        // The task-level "Task closed/errored" toast already covers this.
        if (suppressAgentToasts) continue;

        // Agent stopped transition
        if (prev.status !== 'stopped' && agent.status === 'stopped') {
          const taskId = task.id;
          showToast('info', agentTag(task, agent), 'Agent stopped', {
            label: 'View',
            onClick: () => navigate(`/tasks/${taskId}`),
          });
        }

        // Agent finished (went idle after being active)
        if (prev.hookActivity === 'active' && agent.hook_activity === 'idle') {
          const taskId = task.id;
          showToast('success', agentTag(task, agent), 'Agent finished', {
            label: 'View',
            onClick: () => navigate(`/tasks/${taskId}`),
          });
        }
      }

      // Check for new pending permission prompts
      if (initialized.current && !isViewing && task.pending_prompts) {
        for (const prompt of task.pending_prompts) {
          if (prompt.status === 'pending' && !notifiedPrompts.current.has(prompt.id)) {
            notifiedPrompts.current.add(prompt.id);
            const taskId = task.id;
            const agentId = prompt.agent_id;
            const promptAgent = task.agents?.find((a) => a.id === prompt.agent_id);
            const promptTag = promptAgent ? agentTag(task, promptAgent) : `${task.title} #?`;
            showToast('warning', promptTag, `Needs permission: ${prompt.tool_name}`, {
              label: 'View',
              onClick: () => navigate(`/tasks/${taskId}?agent=${agentId}`),
            });
          }
        }
      }
    }

    // Fire task-level transition toasts after the agent loop so they appear
    // last in the stack (most recently fired = most visible in Sonner).
    for (const taskId of taskTransitioning) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) continue;
      if (task.runtime_state === 'error') {
        showToast('error', task.title, 'Task errored', {
          label: 'View',
          onClick: () => navigate(`/tasks/${taskId}`),
        });
      } else {
        showToast('success', task.title, 'Task closed', {
          label: 'View',
          onClick: () => navigate(`/tasks/${taskId}`),
        });
      }
    }

    prevAgents.current = currentAgents;

    // Seed initial prompts so we don't notify for pre-existing ones
    if (!initialized.current) {
      for (const task of tasks) {
        if (task.pending_prompts) {
          for (const prompt of task.pending_prompts) {
            notifiedPrompts.current.add(prompt.id);
          }
        }
      }
      initialized.current = true;
    }
  }, [tasks, navigate, viewingTaskId]);
}
