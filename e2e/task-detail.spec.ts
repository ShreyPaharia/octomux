import { test, expect } from '@playwright/test';
import { E2eTaskTracker, waitForStatus } from './helpers';

const tracker = new E2eTaskTracker();
let taskId: string;

test.beforeEach(async ({ page }) => {
  const task = await tracker.create(page);
  taskId = task.id;
  await waitForStatus(page, taskId, 'running');
});

test.afterEach(async ({ page }) => {
  await tracker.cleanup(page);
});

test.describe('Task Detail', () => {
  test('shows task header, status, and agent tabs', async ({ page }) => {
    await page.goto(`/tasks/${taskId}`);

    await expect(page.getByRole('heading', { name: 'E2E Test Task' })).toBeVisible();
    await expect(page.getByText('Running')).toBeVisible();
    await expect(
      page.getByRole('paragraph').filter({ hasText: 'Automated test task' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  test('renders a live terminal with content', async ({ page }) => {
    await page.goto(`/tasks/${taskId}`);

    const terminal = page.locator('.xterm-screen');
    await expect(terminal).toBeVisible({ timeout: 10_000 });

    await page.waitForTimeout(3000);
    const termText = await page.locator('.xterm-rows').textContent();
    expect(termText).toBeTruthy();
    expect(termText!.length).toBeGreaterThan(10);
  });

  test('adds a second agent via + button', async ({ page }) => {
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('button', { name: 'Agent 1' })).toBeVisible();

    await page.getByRole('button', { name: '+' }).click();

    await expect(page.getByRole('button', { name: 'Agent 2' })).toBeVisible({ timeout: 10_000 });
  });

  test('switches between agent tabs', async ({ page }) => {
    await page.request.post(`http://localhost:7777/api/tasks/${taskId}/agents`, {
      data: {},
    });

    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('button', { name: 'Agent 2' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Agent 1' }).click();
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: 'Agent 2' }).click();
    await page.waitForTimeout(1000);

    await expect(page.getByRole('button', { name: 'Agent 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent 2' })).toBeVisible();
  });

  test('closes task and updates UI', async ({ page }) => {
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();

    await page.getByRole('button', { name: 'Close' }).click();

    await expect(page.getByText('Closed')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Close' })).toBeHidden();
  });

  test('navigates back to dashboard via Back button', async ({ page }) => {
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();

    await page.getByRole('button', { name: 'Back' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'octomux' })).toBeVisible();
  });
});
