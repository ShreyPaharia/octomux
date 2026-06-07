import { test, expect } from '@playwright/test';
import { E2eTaskTracker, fillCreateDialog } from './helpers';

const tracker = new E2eTaskTracker();

test.afterEach(async ({ page }) => {
  await tracker.cleanup(page);
});

test.describe('Dashboard', () => {
  test('shows empty state when no tasks exist', async ({ page }) => {
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
    await page.goto('/');
    await expect(page.getByText('No tasks yet')).toBeVisible();
    await expect(page.getByText('Create a task to get started')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible();
  });

  test('opens create task dialog and validates required fields', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Task' }).click();

    // Dialog opens
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();

    // Create button is disabled when fields are empty
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();

    // Fill only title — still disabled
    await page.locator('#title').click({ force: true });
    await page.locator('#title').pressSequentially('Test', { delay: 15 });
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  test('creates a task via dialog and shows it in the list', async ({ page }) => {
    await page.route('**/api/tasks', async (route) => {
      if (route.request().method() === 'POST') {
        const response = await route.fetch();
        const body = (await response.json()) as { id: string };
        tracker.track(body.id);
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'New Task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await fillCreateDialog(page, {
      title: 'Dashboard E2E Task',
      description: 'Testing task creation from UI',
      repoPath: process.cwd(),
    });

    await page.getByRole('button', { name: 'Create' }).click();

    // Dialog closes, task appears in list
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText('Dashboard E2E Task')).toBeVisible();
    await expect(page.getByText('Testing task creation from UI')).toBeVisible();

    // Status transitions to Running
    await expect(page.getByText('Running')).toBeVisible({ timeout: 15_000 });
  });

  test('deletes a task from the dashboard', async ({ page }) => {
    const task = await tracker.createWithData(page, {
      title: 'To Be Deleted',
      description: 'Will be removed',
      repo_path: process.cwd(),
    });

    await page.goto('/');
    await expect(page.getByText('To Be Deleted')).toBeVisible({ timeout: 10_000 });

    // Click the delete button (trash icon)
    await page.locator('button:has(> svg)').last().click();

    // Task disappears — may or may not return to empty state if other tasks exist
    await expect(page.getByText('To Be Deleted')).toBeHidden();

    // Already deleted via UI — drop from tracker so afterEach doesn't retry
    tracker.untrack(task.id);
  });
});
