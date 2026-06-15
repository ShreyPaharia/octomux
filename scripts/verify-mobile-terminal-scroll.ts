/* eslint-disable no-console -- CLI verifier script */
/**
 * Verifier: open a live task on mobile viewport, exercise terminal scroll paths.
 * Usage: bunx tsx scripts/verify-mobile-terminal-scroll.ts [taskUrl]
 *
 * IMPORTANT: target a task whose terminal is in xterm's NORMAL buffer with
 * scrollback (tmux `alternate_on=0`, `history_size > rows`). Agents running a
 * full-screen TUI (Claude Code) sit in the ALTERNATE screen buffer, which has no
 * scrollback — neither touch nor the Older button can scroll it, so the run is
 * inconclusive. Find a suitable session with:
 *   tmux list-windows -t octomux-agent-<id> -F '#{alternate_on} #{history_size}'
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const TASK_URL = process.argv[2] ?? 'http://localhost:5173/tasks/bUQ3yScIXxSV';
const OUT_DIR = path.resolve('ui-review/mobile-scroll-check');

type RowSnapshot = {
  firstRow: string;
  rows: string[];
  scrollTop: number;
  docScroll: number;
};

async function readRowSnapshot(page: import('playwright').Page): Promise<RowSnapshot | null> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.xterm-viewport') as HTMLElement | null;
    const rowEls = document.querySelectorAll('.xterm-rows > div');
    const rows = Array.from(rowEls)
      .slice(0, 5)
      .map((el) => el.textContent?.trim() ?? '');
    return {
      firstRow: rows[0] ?? '',
      rows,
      scrollTop: viewport?.scrollTop ?? 0,
      docScroll: document.documentElement.scrollTop,
    };
  });
}

function rowsChanged(before: RowSnapshot, after: RowSnapshot): boolean {
  if (before.firstRow !== after.firstRow) return true;
  return before.rows.some((row, i) => row !== after.rows[i]);
}

/**
 * Finger swipe on the terminal host (same path as the real mobile touch handler).
 * Written as a single linear block with no nested functions so esbuild/tsx does
 * not inject its `__name` keepNames helper (undefined in the page context).
 */
async function swipeTerminalHost(page: import('playwright').Page, distanceY: number) {
  await page.evaluate((distance) => {
    const host = document.querySelector('.octomux-terminal-host');
    if (!host) throw new Error('octomux-terminal-host not found');

    const target = host.querySelector('.xterm-rows > div') ?? host;
    const rect = host.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const startY = rect.top + rect.height * 0.45;
    const steps = 14;

    const ys: number[] = [startY];
    for (let i = 1; i <= steps; i++) ys.push(startY + (distance / steps) * i);
    ys.push(startY + distance);

    for (let i = 0; i < ys.length; i++) {
      const type = i === 0 ? 'touchstart' : i === ys.length - 1 ? 'touchend' : 'touchmove';
      const y = ys[i];
      const touch = new Touch({
        identifier: 1,
        target,
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
      const list = type === 'touchend' ? [] : [touch];
      host.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: list,
          targetTouches: list,
          changedTouches: [touch],
        }),
      );
    }
  }, distanceY);
}

async function ensureAgentsMode(page: import('playwright').Page) {
  const diffToggle = page.getByTestId('diff-toggle');
  if (await diffToggle.isVisible().catch(() => false)) {
    const active = await diffToggle.getAttribute('data-active');
    if (active === 'true') {
      await diffToggle.click();
      await page.waitForTimeout(400);
    }
  }
  await page
    .locator('.octomux-terminal-host')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  console.log(`Opening ${TASK_URL}`);
  await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2000);
  await ensureAgentsMode(page);
  await page
    .getByTestId('mobile-terminal-scroll-controls')
    .waitFor({ state: 'visible', timeout: 30_000 });
  // The first row is frequently blank; wait on the whole rows container instead.
  await page.waitForFunction(
    () => (document.querySelector('.xterm-rows')?.textContent?.trim().length ?? 0) > 20,
    { timeout: 45_000 },
  );

  await page.screenshot({ path: path.join(OUT_DIR, '00-page-loaded.png'), fullPage: true });

  const baseline = await readRowSnapshot(page);
  if (!baseline) throw new Error('could not read terminal rows');
  console.log('Baseline first row:', JSON.stringify(baseline.firstRow.slice(0, 80)));

  const host = page.locator('.octomux-terminal-host').first();
  await host.screenshot({ path: path.join(OUT_DIR, '01-terminal-baseline.png') });

  const scrollControls = page.getByTestId('mobile-terminal-scroll-controls');
  const hasScrollControls = await scrollControls
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  let buttonScrollWorked = false;
  if (hasScrollControls) {
    await page.getByRole('button', { name: 'Older output' }).click();
    await page.waitForTimeout(400);
    const afterButton = await readRowSnapshot(page);
    buttonScrollWorked = !!afterButton && rowsChanged(baseline, afterButton);
    console.log('After Older button:', afterButton?.firstRow.slice(0, 80));
    await host.screenshot({ path: path.join(OUT_DIR, '02-after-older-button.png') });
    await page.getByRole('button', { name: 'Jump to latest output' }).click();
    await page.waitForTimeout(400);
  } else {
    console.log('Mobile scroll controls not visible (still connecting or not mobile?)');
  }

  const beforeTouch = await readRowSnapshot(page);
  if (!beforeTouch) throw new Error('could not read rows before touch');

  // The terminal opens pinned to the latest output. Content follows the finger,
  // so dragging DOWN reveals older scrollback (the only direction that changes
  // rows from the bottom); dragging UP afterwards returns to the newest output.
  console.log('DOM touch swipe DOWN on host (finger down → older), deltaY=+200');
  await swipeTerminalHost(page, 200);
  await page.waitForTimeout(500);

  const afterTouchDown = await readRowSnapshot(page);
  const touchScrollWorked = !!afterTouchDown && rowsChanged(beforeTouch, afterTouchDown);
  console.log('After finger-down swipe:', afterTouchDown?.firstRow.slice(0, 80));
  await host.screenshot({ path: path.join(OUT_DIR, '03-after-touch-down.png') });

  // Swipe back up to return to the latest output.
  await swipeTerminalHost(page, -200);
  await page.waitForTimeout(400);

  console.log('\n--- Result ---');
  console.log(`scroll controls visible: ${hasScrollControls}`);
  console.log(`Older button changed visible rows: ${buttonScrollWorked}`);
  console.log(`touch swipe changed visible rows: ${touchScrollWorked}`);
  console.log(
    `viewport scrollTop (informational): ${baseline.scrollTop} → ${afterTouchDown?.scrollTop}`,
  );
  console.log(
    `document scroll stayed 0: ${baseline.docScroll === 0 && (afterTouchDown?.docScroll ?? 0) === 0}`,
  );
  console.log(`Screenshots: ${OUT_DIR}`);

  await browser.close();

  if (!buttonScrollWorked && !touchScrollWorked) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
