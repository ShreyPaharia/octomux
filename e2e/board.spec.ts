import { test, expect } from '@playwright/test';
import { deleteAllTasks } from './helpers';

const SERVER_URL = (process.env.OCTOMUX_URL || 'http://localhost:7777').replace(/\/$/, '');
const API = `${SERVER_URL}/api`;

test.beforeEach(async ({ page }) => {
  await deleteAllTasks(page);
});

test.afterEach(async ({ page }) => {
  await deleteAllTasks(page);
});

test.describe('Board', () => {
  test('shows all 6 columns on /tasks', async ({ page }) => {
    await page.goto('/tasks');

    // All 6 columns should be visible
    await expect(page.getByTestId('board-column-backlog')).toBeVisible();
    await expect(page.getByTestId('board-column-planned')).toBeVisible();
    await expect(page.getByTestId('board-column-in_progress')).toBeVisible();
    await expect(page.getByTestId('board-column-human_review')).toBeVisible();
    await expect(page.getByTestId('board-column-pr')).toBeVisible();
    await expect(page.getByTestId('board-column-done')).toBeVisible();
  });

  test('shows empty state placeholders when no tasks', async ({ page }) => {
    await page.goto('/tasks');
    const empties = page.getByText('Empty');
    await expect(empties.first()).toBeVisible();
    expect(await empties.count()).toBeGreaterThanOrEqual(6);
  });

  test('shows board filter bar with needs attention and search', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.getByTestId('board-filter-bar')).toBeVisible();
    await expect(page.getByTestId('filter-needs-attention')).toBeVisible();
    await expect(page.getByTestId('board-search')).toBeVisible();
  });

  test('task appears in the correct column after creation', async ({ page }) => {
    // Create a task via API in the 'backlog' workflow_status
    const res = await page.request.post(`${API}/tasks`, {
      data: {
        title: 'Board E2E Task',
        description: 'Test task for board',
        repo_path: process.cwd(),
        workflow_status: 'backlog',
        draft: true, // draft so it doesn't start tmux
      },
    });
    expect(res.ok()).toBeTruthy();
    const task = await res.json();

    await page.goto('/tasks');

    // Task appears in backlog column
    const backlogCol = page.getByTestId('board-column-backlog');
    await expect(backlogCol.getByText('Board E2E Task')).toBeVisible({ timeout: 10_000 });

    // Clean up
    await page.request.delete(`${API}/tasks/${task.id}`);
  });

  test('task can be moved via API and reflects in the board', async ({ page }) => {
    // Create task
    const res = await page.request.post(`${API}/tasks`, {
      data: {
        title: 'Move Test Task',
        description: 'Will be moved',
        repo_path: process.cwd(),
        workflow_status: 'backlog',
        draft: true,
      },
    });
    expect(res.ok()).toBeTruthy();
    const task = await res.json();

    // Move it to planned via API
    const moveRes = await page.request.post(`${API}/tasks/${task.id}/move`, {
      data: { workflow_status: 'in_progress', note: 'Moving via API for test' },
    });
    expect(moveRes.ok()).toBeTruthy();

    await page.goto('/tasks');

    // Should now appear in in_progress column
    const inProgressCol = page.getByTestId('board-column-in_progress');
    await expect(inProgressCol.getByText('Move Test Task')).toBeVisible({ timeout: 10_000 });

    // Should NOT appear in backlog
    const backlogCol = page.getByTestId('board-column-backlog');
    await expect(backlogCol.getByText('Move Test Task')).not.toBeVisible();

    // Clean up
    await page.request.delete(`${API}/tasks/${task.id}`);
  });

  test('needs attention filter shows only human_review tasks', async ({ page }) => {
    // Create two tasks
    const normalRes = await page.request.post(`${API}/tasks`, {
      data: {
        title: 'Normal Backlog Task',
        description: 'Not needing attention',
        repo_path: process.cwd(),
        workflow_status: 'backlog',
        draft: true,
      },
    });
    const reviewRes = await page.request.post(`${API}/tasks`, {
      data: {
        title: 'Human Review Task',
        description: 'Needs attention',
        repo_path: process.cwd(),
        workflow_status: 'human_review',
        draft: true,
      },
    });
    expect(normalRes.ok()).toBeTruthy();
    expect(reviewRes.ok()).toBeTruthy();
    const normalTask = await normalRes.json();
    const reviewTask = await reviewRes.json();

    await page.goto('/tasks');

    // Both visible initially
    await expect(page.getByText('Normal Backlog Task')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Human Review Task')).toBeVisible({ timeout: 10_000 });

    // Toggle needs attention
    await page.getByTestId('filter-needs-attention').click();

    // Only review task visible
    await expect(page.getByText('Human Review Task')).toBeVisible();
    await expect(page.getByText('Normal Backlog Task')).not.toBeVisible();

    // Clean up
    await page.request.delete(`${API}/tasks/${normalTask.id}`);
    await page.request.delete(`${API}/tasks/${reviewTask.id}`);
  });

  test('search filters tasks by title', async ({ page }) => {
    const alpha = await page.request.post(`${API}/tasks`, {
      data: {
        title: 'Alpha Feature',
        description: 'first',
        repo_path: process.cwd(),
        draft: true,
      },
    });
    const beta = await page.request.post(`${API}/tasks`, {
      data: {
        title: 'Beta Bugfix',
        description: 'second',
        repo_path: process.cwd(),
        draft: true,
      },
    });
    expect(alpha.ok()).toBeTruthy();
    expect(beta.ok()).toBeTruthy();
    const alphaTask = await alpha.json();
    const betaTask = await beta.json();

    await page.goto('/tasks');
    await expect(page.getByText('Alpha Feature')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Beta Bugfix')).toBeVisible({ timeout: 10_000 });

    // Search for alpha
    await page.getByTestId('board-search').fill('alpha');

    await expect(page.getByText('Alpha Feature')).toBeVisible();
    await expect(page.getByText('Beta Bugfix')).not.toBeVisible();

    // Clean up
    await page.request.delete(`${API}/tasks/${alphaTask.id}`);
    await page.request.delete(`${API}/tasks/${betaTask.id}`);
  });
});
