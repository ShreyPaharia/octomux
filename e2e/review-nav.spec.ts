import { test, expect } from '@playwright/test';
import { createReviewFixture, deleteReviewTask } from './helpers-review';

/**
 * Regression for the review-detail navigation lockup (react-router#12552).
 *
 * Root cause: an unstable-reference render loop between DiffViewer and
 * ReviewDetailPage (DiffViewer emitted `onFilesChange` on every render → host
 * re-derived `fileOrder`/`groups` → new refs → DiffViewer re-rendered → emit
 * again). React Router v7 commits location updates inside `startTransition`
 * (low priority), so that render storm permanently starved the navigation:
 * the URL changed but the route never swapped and NavLink active state never
 * updated. The old workaround forced a full `window.location.assign` reload.
 *
 * This test mocks a multi-file diff so the (previously looping) data flow is
 * exercised, then asserts that clicking a sidebar link performs a real SPA
 * navigation — route swaps, NavLink active state updates, and crucially no full
 * page reload.
 */

const DIFF_FILES = Array.from({ length: 14 }, (_, i) => `src/area-${i}/module-${i}.ts`);

test.describe('Review detail → SPA navigation (nav-lockup regression)', () => {
  let taskId: string;

  test.beforeEach(async ({ page }) => {
    taskId = await createReviewFixture(page);

    // Mock the diff summary with many files. The file list alone drives the
    // render loop (it does not depend on Monaco), so the files are marked
    // binary to keep the test fast and avoid mounting editors in CI.
    await page.route(/\/api\/tasks\/[^/]+\/diff(\?.*)?$/, async (route) => {
      await route.fulfill({
        json: {
          files: DIFF_FILES.map((path) => ({
            path,
            status: 'M',
            additions: 8,
            deletions: 3,
            post_blob_sha: null,
            reviewed: false,
            reviewed_at: null,
            reviewed_at_commit: null,
            changed_since_review: false,
            ignored: false,
            tooLarge: false,
            binary: true,
          })),
          ignoredTruncated: false,
        },
      });
    });
  });

  test.afterEach(async ({ page }) => {
    if (taskId) await deleteReviewTask(page, taskId);
  });

  test('clicking a sidebar nav link navigates SPA-style without a full reload', async ({
    page,
  }) => {
    await page.goto(`/reviews/${taskId}`);

    // File tree is populated from the mocked summary → the review page is live.
    await expect(page.getByTestId('review-file-tree')).toBeVisible({ timeout: 15_000 });

    // Give the (pre-fix) render loop time to spin before we navigate.
    await page.waitForTimeout(2_500);

    // A full page reload wipes window globals; this sentinel detects it.
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    const tasksLink = page.locator('a[href="/tasks"]').first();
    await tasksLink.click();

    // The new route must actually render (pre-fix: URL changed but route never swapped).
    await expect(page).toHaveURL(/\/tasks$/, { timeout: 8_000 });
    await expect(page.getByTestId('board-filter-bar')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('review-file-tree')).toHaveCount(0);

    // NavLink active state updates (pre-fix: aria-current stayed null).
    await expect(page.locator('a[href="/tasks"]').first()).toHaveAttribute('aria-current', 'page');

    // SPA navigation — no full page reload (pre-fix workaround did location.assign).
    const noReload = await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    );
    expect(noReload).toBe(true);
  });
});
