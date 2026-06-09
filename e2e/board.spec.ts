import { test, expect } from '@playwright/test';
import { E2eTaskTracker } from './helpers';

const tracker = new E2eTaskTracker();

test.afterEach(async ({ page }) => {
  await tracker.cleanup(page);
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
    await page.route('**/api/tasks', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      } else {
        route.continue();
      }
    });
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
    await tracker.createWithData(page, {
      title: 'Board E2E Task',
      description: 'Test task for board',
      repo_path: process.cwd(),
      workflow_status: 'backlog',
      draft: true,
    });

    await page.goto('/tasks');

    const backlogCol = page.getByTestId('board-column-backlog');
    await expect(backlogCol.getByText('Board E2E Task')).toBeVisible({ timeout: 10_000 });
  });

  test('task can be moved via API and reflects in the board', async ({ page }) => {
    const task = await tracker.createWithData(page, {
      title: 'Move Test Task',
      description: 'Will be moved',
      repo_path: process.cwd(),
      workflow_status: 'backlog',
      draft: true,
    });

    const moveRes = await page.request.post(`http://localhost:7777/api/tasks/${task.id}/move`, {
      data: { workflow_status: 'in_progress', note: 'Moving via API for test' },
    });
    expect(moveRes.ok()).toBeTruthy();

    await page.goto('/tasks');

    const inProgressCol = page.getByTestId('board-column-in_progress');
    await expect(inProgressCol.getByText('Move Test Task')).toBeVisible({ timeout: 10_000 });

    const backlogCol = page.getByTestId('board-column-backlog');
    await expect(backlogCol.getByText('Move Test Task')).not.toBeVisible();
  });

  test('needs attention filter shows only human_review tasks', async ({ page }) => {
    await tracker.createWithData(page, {
      title: 'Normal Backlog Task',
      description: 'Not needing attention',
      repo_path: process.cwd(),
      workflow_status: 'backlog',
      draft: true,
    });
    await tracker.createWithData(page, {
      title: 'Human Review Task',
      description: 'Needs attention',
      repo_path: process.cwd(),
      workflow_status: 'human_review',
      draft: true,
    });

    await page.goto('/tasks');

    await expect(page.getByText('Normal Backlog Task')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Human Review Task')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('filter-needs-attention').click();

    await expect(page.getByText('Human Review Task')).toBeVisible();
    await expect(page.getByText('Normal Backlog Task')).not.toBeVisible();
  });

  test('search filters tasks by title', async ({ page }) => {
    await tracker.createWithData(page, {
      title: 'Alpha Feature',
      description: 'first',
      repo_path: process.cwd(),
      draft: true,
    });
    await tracker.createWithData(page, {
      title: 'Beta Bugfix',
      description: 'second',
      repo_path: process.cwd(),
      draft: true,
    });

    await page.goto('/tasks');
    await expect(page.getByText('Alpha Feature')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Beta Bugfix')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('board-search').fill('alpha');

    await expect(page.getByText('Alpha Feature')).toBeVisible();
    await expect(page.getByText('Beta Bugfix')).not.toBeVisible();
  });
});
