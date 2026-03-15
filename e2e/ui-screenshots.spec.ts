/**
 * Playwright script to capture screenshots of every page and UI state
 * in the octomux dashboard for design review.
 *
 * Run: npx playwright test e2e/ui-screenshots.ts
 *
 * Prerequisites: Both servers must be running (bun run dev)
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:7777/api';
const SCREENSHOTS = 'ui-review/screenshots';

const DESKTOP = { width: 1920, height: 1080 };
const TABLET = { width: 768, height: 1024 };
const MOBILE = { width: 375, height: 812 };

async function shot(page: import('@playwright/test').Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

async function createDraftTask(
  page: import('@playwright/test').Page,
  overrides: Record<string, string> = {},
) {
  const res = await page.request.post(`${API}/tasks`, {
    data: {
      title: overrides.title ?? 'Test Task',
      description: overrides.description ?? 'A test task',
      repo_path:
        overrides.repo_path ?? '/Users/shreypaharia/Documents/Projects/Ostium/octomux-agents',
      branch: overrides.branch ?? undefined,
      base_branch: overrides.base_branch ?? undefined,
      draft: true,
    },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { id: string; status: string };
}

// Track test tasks so we can clean them up
const testTaskIds: string[] = [];

test.describe.serial('UI Screenshots', () => {
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    for (const id of testTaskIds) {
      await page.request.delete(`${API}/tasks/${id}`).catch(() => {});
    }
    await page.close();
  });

  // ── Dashboard: Live state (real running tasks) ──────────────────────

  test('01 dashboard - live with real tasks (desktop)', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.waitForTimeout(1500); // Wait for polling to populate
    await shot(page, '01-dashboard-live-desktop');
  });

  test('02 dashboard - closed tab', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.waitForTimeout(1000);
    const closedTab = page.locator('button', { hasText: /Closed/ });
    if (await closedTab.isVisible()) {
      await closedTab.click();
      await page.waitForTimeout(500);
    }
    await shot(page, '02-dashboard-closed-tab');
  });

  test('03 dashboard - repo filter', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.waitForTimeout(1000);
    const select = page.locator('select');
    if (await select.isVisible()) {
      // Open dropdown to show options
      await select.focus();
      await shot(page, '03-dashboard-repo-filter');
    }
  });

  // ── Create Task Dialog ──────────────────────────────────────────────

  test('04 create dialog - empty', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'New Task' }).click();
    await page.waitForSelector('text=Create Task');
    await page.waitForTimeout(500);
    await shot(page, '04-create-dialog-empty');
  });

  test('05 create dialog - filled with all fields', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'New Task' }).click();
    await page.waitForSelector('text=Create Task');

    await page.locator('#title').click({ force: true });
    await page.locator('#title').pressSequentially('Implement rate limiting for API endpoints', {
      delay: 8,
    });

    await page.locator('#description').click({ force: true });
    await page
      .locator('#description')
      .pressSequentially(
        'Add configurable rate limiting middleware with Redis backend for all public-facing API routes. Include per-endpoint limits and IP-based throttling.',
        { delay: 3 },
      );

    await page.locator('#repo-path').click({ force: true });
    await page
      .locator('#repo-path')
      .pressSequentially('/Users/shreypaharia/Documents/Projects/Ostium/nucleus', { delay: 5 });

    await page.locator('#branch').click({ force: true });
    await page.locator('#branch').pressSequentially('feat/rate-limiting', { delay: 8 });

    // Wait for branches to load
    await page.waitForTimeout(500);

    // Expand initial prompt
    const promptToggle = page.locator('button', { hasText: 'Add initial prompt' });
    if (await promptToggle.isVisible()) {
      await promptToggle.click();
      await page.waitForTimeout(200);
      await page.locator('#initial-prompt').click({ force: true });
      await page
        .locator('#initial-prompt')
        .pressSequentially(
          'Implement a Redis-backed rate limiter middleware using a sliding window algorithm. Configure per-route limits in a central config file.',
          { delay: 2 },
        );
    }

    // Check draft checkbox
    await page.locator('input[type="checkbox"]').check();
    await page.waitForTimeout(300);
    await shot(page, '05-create-dialog-filled');
  });

  // ── Task Detail: Real running task ──────────────────────────────────

  test('06 task detail - running task with terminal', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Find a running task
    const res = await page.request.get(`${API}/tasks`);
    const tasks = (await res.json()) as { id: string; status: string }[];
    const runningTask = tasks.find((t) => t.status === 'running');
    if (!runningTask) {
      test.skip();
      return;
    }
    await page.goto(`/tasks/${runningTask.id}`);
    await page.waitForTimeout(2000); // Wait for terminal to connect
    await shot(page, '06-task-detail-running');
  });

  test('07 task detail - needs_attention task', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const res = await page.request.get(`${API}/tasks`);
    const tasks = (await res.json()) as {
      id: string;
      status: string;
      derived_status: string | null;
    }[];
    const attentionTask = tasks.find((t) => t.derived_status === 'needs_attention');
    if (!attentionTask) {
      test.skip();
      return;
    }
    await page.goto(`/tasks/${attentionTask.id}`);
    await page.waitForTimeout(2000);
    await shot(page, '07-task-detail-needs-attention');
  });

  test('08 task detail - done/completed task', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const res = await page.request.get(`${API}/tasks`);
    const tasks = (await res.json()) as {
      id: string;
      status: string;
      derived_status: string | null;
    }[];
    const doneTask = tasks.find((t) => t.derived_status === 'done');
    if (!doneTask) {
      test.skip();
      return;
    }
    await page.goto(`/tasks/${doneTask.id}`);
    await page.waitForTimeout(2000);
    await shot(page, '08-task-detail-done');
  });

  // ── Task Detail: Draft task ─────────────────────────────────────────

  test('09 task detail - draft task', async ({ page }) => {
    const task = await createDraftTask(page, {
      title: 'Implement real-time notifications',
      description:
        'Add WebSocket-based notification system for task status changes, agent completions, and permission prompts',
      branch: 'feat/notifications',
      base_branch: 'main',
    });
    testTaskIds.push(task.id);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/tasks/${task.id}`);
    await page.waitForSelector('text=Implement real-time notifications');
    await page.waitForTimeout(500);
    await shot(page, '09-task-detail-draft');
  });

  test('10 task detail - not found', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/tasks/nonexistent_id');
    await page.waitForSelector('text=Task not found');
    await shot(page, '10-task-detail-not-found');
  });

  // ── Dashboard: Empty state ──────────────────────────────────────────
  // NOTE: We do this last to avoid disrupting real tasks. We temporarily
  // intercept the API to simulate an empty state.

  test('11 dashboard - empty state', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
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
    await page.waitForSelector('text=No tasks yet');
    await page.waitForTimeout(300);
    await shot(page, '11-dashboard-empty-state');
    await page.unroute('**/api/tasks');
  });

  // ── Loading & Error States ──────────────────────────────────────────

  test('12 dashboard - loading skeleton', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.route('**/api/tasks', async (route) => {
      await new Promise((r) => setTimeout(r, 10000));
      await route.continue();
    });
    await page.goto('/');
    await page.waitForTimeout(300);
    await shot(page, '12-dashboard-loading-skeleton');
    await page.unroute('**/api/tasks');
  });

  test('13 dashboard - API error', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.route('**/api/tasks', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error' }),
      });
    });
    await page.goto('/');
    await page.waitForTimeout(1000);
    await shot(page, '13-dashboard-api-error');
    await page.unroute('**/api/tasks');
  });

  // ── Responsive Views ────────────────────────────────────────────────

  test('14 responsive - dashboard tablet', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await shot(page, '14-responsive-dashboard-tablet');
  });

  test('15 responsive - dashboard mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await shot(page, '15-responsive-dashboard-mobile');
  });

  test('16 responsive - task detail tablet', async ({ page }) => {
    const res = await page.request.get(`${API}/tasks`);
    const tasks = (await res.json()) as { id: string; status: string }[];
    const task = tasks.find((t) => t.status === 'running') ?? tasks[0];
    if (!task) {
      test.skip();
      return;
    }

    await page.setViewportSize(TABLET);
    await page.goto(`/tasks/${task.id}`);
    await page.waitForTimeout(1500);
    await shot(page, '16-responsive-task-detail-tablet');
  });

  test('17 responsive - task detail mobile', async ({ page }) => {
    const res = await page.request.get(`${API}/tasks`);
    const tasks = (await res.json()) as { id: string; status: string }[];
    const task = tasks.find((t) => t.status === 'running') ?? tasks[0];
    if (!task) {
      test.skip();
      return;
    }

    await page.setViewportSize(MOBILE);
    await page.goto(`/tasks/${task.id}`);
    await page.waitForTimeout(1500);
    await shot(page, '17-responsive-task-detail-mobile');
  });

  test('18 responsive - create dialog tablet', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'New Task' }).click();
    await page.waitForSelector('text=Create Task');
    await page.waitForTimeout(300);
    await shot(page, '18-responsive-create-dialog-tablet');
  });

  test('19 responsive - create dialog mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.locator('button', { hasText: 'New Task' }).click();
    await page.waitForSelector('text=Create Task');
    await page.waitForTimeout(300);
    await shot(page, '19-responsive-create-dialog-mobile');
  });
});
