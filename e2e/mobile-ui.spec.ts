import { test, expect } from '@playwright/test';
import { createTaskViaAPI, deleteAllTasks } from './helpers';

const MOBILE = { width: 375, height: 812 };
const SCREENSHOTS = 'ui-review/screenshots';

test.describe('Mobile UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await deleteAllTasks(page);
  });

  test.afterEach(async ({ page }) => {
    await deleteAllTasks(page);
  });

  test('home page fits viewport without horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth;
    });
    expect(overflow).toBe(false);

    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SCREENSHOTS}/mobile-home.png`, fullPage: true });
  });

  test('mobile bottom nav is visible and navigates', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByTestId('mobile-bottom-nav');
    await expect(nav).toBeVisible();

    await nav.getByRole('link', { name: 'Tasks' }).click();
    await expect(page).toHaveURL('/tasks');
    await expect(page.getByTestId('page-eyebrow')).toBeVisible();

    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL('/settings');
  });

  test('tasks page header stacks on narrow screens', async ({ page }) => {
    await createTaskViaAPI(page, { title: 'Mobile layout task' });
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible();

    const header = page.locator('header').first();
    const box = await header.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(MOBILE.width);
    }

    await page.screenshot({ path: `${SCREENSHOTS}/mobile-tasks.png`, fullPage: true });
  });

  test('composer fits mobile viewport without overlapping header', async ({ page }) => {
    await page.goto('/');
    const composer = page.getByTestId('composer');
    await expect(composer).toBeVisible();

    const composerBox = await composer.boundingBox();
    const headerBox = await page.getByRole('heading', { name: 'Welcome back' }).boundingBox();
    expect(composerBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    if (composerBox && headerBox) {
      expect(composerBox.x).toBeGreaterThanOrEqual(0);
      expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(MOBILE.width + 1);
      expect(composerBox.y).toBeGreaterThan(headerBox.y + headerBox.height - 4);
    }

    await page.screenshot({ path: `${SCREENSHOTS}/mobile-composer.png`, fullPage: true });
  });

  test('task detail header does not overflow viewport', async ({ page }) => {
    const task = await createTaskViaAPI(page, { title: 'Mobile detail task' });
    await page.goto(`/tasks/${task.id}`);
    await expect(page.getByTestId('task-detail-header')).toBeVisible({ timeout: 15_000 });

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth;
    });
    expect(overflow).toBe(false);

    await page.screenshot({ path: `${SCREENSHOTS}/mobile-task-detail.png`, fullPage: true });
  });
});
