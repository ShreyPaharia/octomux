import { test, expect } from '@playwright/test';
import { createReviewFixture, deleteReviewTask } from './helpers-review';

const SERVER_URL = (process.env.OCTOMUX_URL || 'http://localhost:7777').replace(/\/$/, '');
const API = `${SERVER_URL}/api`;

let taskId: string;

test.beforeEach(async ({ page }) => {
  taskId = await createReviewFixture(page);
});

test.afterEach(async ({ page }) => {
  if (taskId) {
    await deleteReviewTask(page, taskId);
  }
});

test.describe('Review orchestrator — happy path', () => {
  test('shows review in /reviews list and navigates to detail', async ({ page }) => {
    // 1. Navigate to /reviews
    await page.goto('/reviews');

    // 2. Seeded review should appear — match by PR title text
    await expect(page.getByText(/E2E review PR #99/)).toBeVisible({ timeout: 10_000 });

    // 3. Open review → navigate to /reviews/:id
    await page.getByTestId(`review-inbox-row-${taskId}`).getByRole('button', { name: 'Open review' }).click();
    await expect(page).toHaveURL(new RegExp(`/reviews/${taskId}`), { timeout: 10_000 });
  });

  test('detail page shows walkthrough and two comment cards', async ({ page }) => {
    await page.goto(`/reviews/${taskId}`);

    // WalkthroughTree should be visible — the summary field renders as text
    await expect(page.getByText('E2E test review')).toBeVisible({ timeout: 10_000 });

    // Two comment cards should exist
    const c1Id = `${taskId}-c1`;
    const c2Id = `${taskId}-c2`;
    await expect(page.locator(`#comment-${c1Id}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`#comment-${c2Id}`)).toBeVisible({ timeout: 10_000 });
  });

  test('accept both comments and PublishBar shows 2 accepted, then publish succeeds', async ({
    page,
  }) => {
    await page.goto(`/reviews/${taskId}`);

    const c1Id = `${taskId}-c1`;
    const c2Id = `${taskId}-c2`;

    // Wait for both comment cards to be visible
    await expect(page.locator(`#comment-${c1Id}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`#comment-${c2Id}`)).toBeVisible({ timeout: 10_000 });

    // Accept comment c1
    const c1Card = page.locator(`#comment-${c1Id}`);
    await c1Card.getByRole('button', { name: 'Accept' }).click();
    // Wait for status badge to show "accepted"
    await expect(c1Card.getByText('accepted')).toBeVisible({ timeout: 5_000 });

    // Accept comment c2
    const c2Card = page.locator(`#comment-${c2Id}`);
    await c2Card.getByRole('button', { name: 'Accept' }).click();
    await expect(c2Card.getByText('accepted')).toBeVisible({ timeout: 5_000 });

    // PublishBar should now show "2 accepted"
    await expect(page.getByText(/2 accepted/)).toBeVisible({ timeout: 5_000 });

    // Click Publish review
    await page.getByRole('button', { name: 'Publish review' }).click();

    // Toast: "Review published to GitHub"
    await expect(page.getByText('Review published to GitHub')).toBeVisible({ timeout: 10_000 });

    // Verify via API that comments are now published
    const detail = await page.request.get(`${API}/reviews/${taskId}`);
    expect(detail.ok()).toBeTruthy();
    const body = await detail.json();

    const publishedComments = body.comments.filter(
      (c: { status: string }) => c.status === 'published',
    );
    expect(publishedComments.length).toBe(2);

    // Published history entry should exist with the stub URL
    expect(body.published_history.length).toBeGreaterThan(0);
    expect(body.published_history[0].github_review_url).toBe('https://example.invalid/r/99999');
  });
});
