import { test, expect } from '@playwright/test';
import { deleteAllTasks, fillCreateDialog } from './helpers';

test.beforeEach(async ({ page }) => {
  await deleteAllTasks(page);
});

test.afterEach(async ({ page }) => {
  await deleteAllTasks(page);
});

test.describe('Dashboard', () => {
  test('shows empty state when no tasks exist', async ({ page }) => {
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
    // Create task via API for speed
    const res = await page.request.post('http://localhost:7777/api/tasks', {
      data: {
        title: 'To Be Deleted',
        description: 'Will be removed',
        repo_path: process.cwd(),
      },
    });
    const _task = await res.json();

    await page.goto('/');
    await expect(page.getByText('To Be Deleted')).toBeVisible({ timeout: 10_000 });

    // Click the delete button (trash icon)
    await page.locator('button:has(> svg)').last().click();

    // Task disappears, empty state returns
    await expect(page.getByText('To Be Deleted')).toBeHidden();
    await expect(page.getByText('No tasks yet')).toBeVisible();
  });
});
