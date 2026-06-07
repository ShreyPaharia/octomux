import { test, expect, type Page } from '@playwright/test';
import { E2eTaskTracker, waitForStatus } from './helpers';

const MOBILE = { width: 375, height: 812 };
const tracker = new E2eTaskTracker();

type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  docScroll: number;
};

async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!viewport) {
      throw new Error('xterm viewport not found');
    }
    return {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      docScroll: document.documentElement.scrollTop,
    };
  });
}

/** Seed scrollback taller than the viewport so touch-scroll assertions are deterministic. */
async function ensureTerminalScrollable(page: Page) {
  await page.evaluate(() => {
    const scrollArea = document.querySelector('.xterm-scroll-area') as HTMLElement | null;
    if (!scrollArea) throw new Error('xterm scroll area not found');
    scrollArea.style.height = '2400px';
  });
}

/**
 * Simulate a one-finger vertical swipe on the xterm element (mobile touch path).
 * Negative distanceY moves the finger up, which should increase viewport.scrollTop.
 */
async function swipeTerminal(page: Page, distanceY: number) {
  await page.evaluate((distance) => {
    const el = document.querySelector('.xterm') as HTMLElement | null;
    if (!el) throw new Error('xterm element not found');

    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;

    const makeTouch = (y: number) =>
      new Touch({
        identifier: 1,
        target: el,
        clientX: cx,
        clientY: y,
        pageX: cx,
        pageY: y,
        screenX: cx,
        screenY: y,
        radiusX: 2.5,
        radiusY: 2.5,
        rotationAngle: 0,
        force: 0.5,
      });

    const fire = (type: 'touchstart' | 'touchmove' | 'touchend', y: number) => {
      const touch = makeTouch(y);
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: type === 'touchend' ? [] : [touch],
          targetTouches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
        }),
      );
    };

    const steps = 12;
    fire('touchstart', startY);
    for (let i = 1; i <= steps; i++) {
      fire('touchmove', startY + (distance / steps) * i);
    }
    fire('touchend', startY + distance);
  }, distanceY);
}

test.describe('Mobile terminal touch scroll', () => {
  test.use({ viewport: MOBILE, hasTouch: true });

  test.afterEach(async ({ page }) => {
    await tracker.cleanup(page);
  });

  test('swiping the terminal scrolls xterm viewport, not the document', async ({ page }) => {
    const task = await tracker.create(page, { title: 'Mobile terminal scroll task' });
    await waitForStatus(page, task.id, 'running');

    await page.goto(`/tasks/${task.id}`);
    await expect(page.locator('.octomux-terminal-host')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.xterm-viewport')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('html')).toHaveClass(/octomux-agent-session-active/);

    await ensureTerminalScrollable(page);

    const before = await readScrollMetrics(page);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
    expect(before.docScroll).toBe(0);

    // Finger up → scroll back through agent output.
    await swipeTerminal(page, -180);

    const after = await readScrollMetrics(page);

    expect(after.docScroll).toBe(0);
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  });

  test('pull-down at top of terminal does not scroll the document', async ({ page }) => {
    const task = await tracker.create(page, { title: 'Mobile terminal overscroll task' });
    await waitForStatus(page, task.id, 'running');

    await page.goto(`/tasks/${task.id}`);
    await expect(page.locator('.xterm-viewport')).toBeVisible({ timeout: 15_000 });
    await ensureTerminalScrollable(page);

    await page.evaluate(() => {
      const viewport = document.querySelector('.xterm-viewport') as HTMLElement;
      viewport.scrollTop = 0;
    });

    const before = await readScrollMetrics(page);
    expect(before.scrollTop).toBe(0);

    // Finger down at top — must not chain to document (pull-to-refresh path).
    await swipeTerminal(page, 180);

    const after = await readScrollMetrics(page);
    expect(after.docScroll).toBe(0);
    expect(after.scrollTop).toBe(0);
  });
});
