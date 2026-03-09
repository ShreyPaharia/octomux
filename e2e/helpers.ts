import { type Page, expect } from '@playwright/test';

const API = 'http://localhost:7777/api';

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
  return task as { id: string; status: string };
}

/** Wait for a task to reach a given status via polling. */
export async function waitForStatus(
  page: Page,
  taskId: string,
  status: string,
  timeoutMs = 15_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await page.request.get(`${API}/tasks/${taskId}`);
    const task = await res.json();
    if (task.status === status) return task;
    await page.waitForTimeout(500);
  }
  throw new Error(`Task ${taskId} did not reach status "${status}" within ${timeoutMs}ms`);
}

/** Cancel + delete a task and clean up its resources. */
export async function cleanupTask(page: Page, taskId: string) {
  // Cancel first (stops tmux, removes worktree)
  await page.request.patch(`${API}/tasks/${taskId}`, {
    data: { status: 'cancelled' },
  });
  // Then delete the DB record
  await page.request.delete(`${API}/tasks/${taskId}`);
}

/** Delete all tasks (cleanup between tests). */
export async function deleteAllTasks(page: Page) {
  const res = await page.request.get(`${API}/tasks`);
  const tasks = (await res.json()) as { id: string; status: string }[];
  for (const task of tasks) {
    if (task.status === 'running' || task.status === 'setting_up') {
      await page.request.patch(`${API}/tasks/${task.id}`, {
        data: { status: 'cancelled' },
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
