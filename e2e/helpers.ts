import { type Page, expect } from '@playwright/test';
import type { RuntimeState } from '@octomux/types';

const SERVER_URL = (process.env.OCTOMUX_URL || 'http://localhost:7777').replace(/\/$/, '');
const API = `${SERVER_URL}/api`;

/** Create a task via the API and wait for it to reach running state. */
export async function createTaskViaAPI(
  page: Page,
  overrides: { title?: string; description?: string; repo_path?: string } = {},
) {
  const res = await page.request.post(`${API}/tasks`, {
    data: {
      title: overrides.title ?? 'E2E Test Task',
      description: overrides.description ?? 'Automated test task',
      repo_path: overrides.repo_path ?? process.cwd(),
    },
  });
  expect(res.ok()).toBeTruthy();
  const task = await res.json();
  return task as { id: string; runtime_state: RuntimeState };
}

/** Wait for a task to reach a given runtime_state via polling. */
export async function waitForStatus(
  page: Page,
  taskId: string,
  runtimeState: RuntimeState,
  timeoutMs = 15_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await page.request.get(`${API}/tasks/${taskId}`);
    const task = await res.json();
    if (task.runtime_state === runtimeState) return task;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Task ${taskId} did not reach runtime_state "${runtimeState}" within ${timeoutMs}ms`,
  );
}

/** Close + delete a task and clean up its resources. */
export async function cleanupTask(page: Page, taskId: string) {
  // Close first (stops tmux, removes worktree)
  await page.request.patch(`${API}/tasks/${taskId}`, {
    data: { runtime_state: 'idle' },
  });
  // Then delete the DB record
  await page.request.delete(`${API}/tasks/${taskId}`);
}

/** Tracks tasks created during a test file and cleans up only those IDs. */
export class E2eTaskTracker {
  private readonly ids: string[] = [];

  async create(
    page: Page,
    overrides: { title?: string; description?: string; repo_path?: string } = {},
  ) {
    const task = await createTaskViaAPI(page, overrides);
    this.ids.push(task.id);
    return task;
  }

  async createWithData(page: Page, data: Record<string, unknown>) {
    const res = await page.request.post(`${API}/tasks`, { data });
    expect(res.ok()).toBeTruthy();
    const task = (await res.json()) as { id: string };
    this.ids.push(task.id);
    return task;
  }

  track(taskId: string) {
    this.ids.push(taskId);
  }

  untrack(taskId: string) {
    const i = this.ids.indexOf(taskId);
    if (i >= 0) this.ids.splice(i, 1);
  }

  async cleanup(page: Page) {
    const batch = this.ids.splice(0);
    await cleanupTasks(page, batch);
  }
}

/** Close + delete only the given task IDs (best-effort; ignores failures). */
export async function cleanupTasks(page: Page, taskIds: readonly string[]) {
  for (const id of taskIds) {
    try {
      const res = await page.request.get(`${API}/tasks/${id}`);
      if (!res.ok()) continue;
      const task = (await res.json()) as { runtime_state: RuntimeState };
      if (task.runtime_state === 'running' || task.runtime_state === 'setting_up') {
        await page.request.patch(`${API}/tasks/${id}`, { data: { runtime_state: 'idle' } });
      }
      await page.request.delete(`${API}/tasks/${id}`);
    } catch {
      // task may already be gone
    }
  }
}

/**
 * Delete all tasks. Avoid in E2E — use {@link E2eTaskTracker} against shared dev/prod servers.
 * @deprecated Prefer E2eTaskTracker so existing tasks are not wiped.
 */
export async function deleteAllTasks(page: Page) {
  const res = await page.request.get(`${API}/tasks`);
  const tasks = (await res.json()) as { id: string; runtime_state: RuntimeState }[];
  for (const task of tasks) {
    if (task.runtime_state === 'running' || task.runtime_state === 'setting_up') {
      await page.request.patch(`${API}/tasks/${task.id}`, {
        data: { runtime_state: 'idle' },
      });
    }
    await page.request.delete(`${API}/tasks/${task.id}`);
  }
}

/** Fill the create task dialog using force-click to avoid base-ui dismiss. */
export async function fillCreateDialog(
  page: Page,
  fields: { title: string; description: string; repoPath: string },
) {
  await page.locator('#title').click({ force: true });
  await page.locator('#title').pressSequentially(fields.title, { delay: 15 });

  await page.locator('#description').click({ force: true });
  await page.locator('#description').pressSequentially(fields.description, { delay: 15 });

  await page.locator('#repo-path').click({ force: true });
  await page.locator('#repo-path').pressSequentially(fields.repoPath, { delay: 10 });
}
