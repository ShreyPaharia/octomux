import { useEffect, useRef } from 'react';
import type { Task, Agent } from '../../server/types';
import { sendNotification, getNotificationsEnabled } from './notification-settings';

interface AgentSnapshot {
  status: Agent['status'];
  hookActivity: Agent['hook_activity'];
}

/**
 * Watches tasks for agent state transitions and fires desktop notifications.
 * Accepts the tasks array from useTasks() — no extra fetching.
 */
export function useNotifications(tasks: Task[], navigate: (path: string) => void) {
  const prevAgents = useRef<Map<string, AgentSnapshot>>(new Map());
  const notifiedPrompts = useRef<Set<string>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    if (!getNotificationsEnabled()) return;
    if (tasks.length === 0) return;

    const currentAgents = new Map<string, AgentSnapshot>();

    for (const task of tasks) {
      if (!task.agents) continue;

      for (const agent of task.agents) {
        currentAgents.set(agent.id, {
          status: agent.status,
          hookActivity: agent.hook_activity,
        });

        // Skip notifications on first load to avoid spamming existing state
        if (!initialized.current) continue;

        const prev = prevAgents.current.get(agent.id);
        if (!prev) continue;

        // Agent stopped transition
        if (prev.status !== 'stopped' && agent.status === 'stopped') {
          sendNotification(`${agent.label} stopped`, {
            body: task.title,
            tag: `agent-stopped-${agent.id}`,
            onClick: () => navigate(`/tasks/${task.id}`),
          });
        }
      }

      // Task moved to closed/error
      if (initialized.current) {
        // Check for new pending permission prompts
        if (task.pending_prompts) {
          for (const prompt of task.pending_prompts) {
            if (prompt.status === 'pending' && !notifiedPrompts.current.has(prompt.id)) {
              notifiedPrompts.current.add(prompt.id);
              sendNotification(`${prompt.agent_label} needs permission`, {
                body: `${prompt.tool_name} — ${task.title}`,
                tag: `permission-${prompt.id}`,
                onClick: () => navigate(`/tasks/${task.id}?agent=${prompt.agent_id}`),
              });
            }
          }
        }
      }
    }

    // Task-level transitions (closed/error)
    if (initialized.current) {
      for (const task of tasks) {
        if (task.status === 'closed' || task.status === 'error') {
          // Check if any agent was previously non-stopped (task just ended)
          const hadActiveAgents = task.agents?.some((a) => {
            const prev = prevAgents.current.get(a.id);
            return prev && prev.status !== 'stopped';
          });
          if (hadActiveAgents) {
            sendNotification(task.status === 'error' ? `Task errored` : `Task closed`, {
              body: task.title,
              tag: `task-${task.status}-${task.id}`,
              onClick: () => navigate(`/tasks/${task.id}`),
            });
          }
        }
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
  }, [tasks, navigate]);
}
