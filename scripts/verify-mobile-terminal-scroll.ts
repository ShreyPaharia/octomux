/* eslint-disable no-console -- CLI verifier script */
/**
 * One-off verifier: open a live task, touch-drag the terminal, screenshot before/after.
 * Usage: bunx tsx scripts/verify-mobile-terminal-scroll.ts [taskUrl]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const TASK_URL = process.argv[2] ?? 'http://localhost:7777/tasks/bUQ3yScIXxSV';
const OUT_DIR = path.resolve('ui-review/mobile-scroll-check');

type Metrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  docScroll: number;
};

async function readMetrics(page: import('playwright').Page): Promise<Metrics | null> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!viewport) return null;
    return {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      docScroll: document.documentElement.scrollTop,
    };
  });
}

async function cdpTouchDrag(
  page: import('playwright').Page,
  startX: number,
  startY: number,
  deltaY: number,
  steps = 14,
) {
  const cdp = await page.context().newCDPSession(page);
  const step = deltaY / steps;

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(startX), y: Math.round(startY) }],
  });

  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: Math.round(startX), y: Math.round(startY + step * i) }],
    });
    await page.waitForTimeout(16);
  }

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
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
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(OUT_DIR, '00-page-loaded.png'), fullPage: true });

  const hasTerminal = await page
    .locator('.xterm-viewport')
    .isVisible()
    .catch(() => false);

  if (!hasTerminal) {
    const bodyText = await page.locator('body').innerText();
    console.log('No xterm viewport visible. Page text snippet:', bodyText.slice(0, 500));
    console.log(`Screenshot saved: ${path.join(OUT_DIR, '00-page-loaded.png')}`);
    await browser.close();
    process.exitCode = 2;
    return;
  }

  const host = page.locator('.octomux-terminal-host').first();
  const target = (await host.isVisible()) ? host : page.locator('.xterm-viewport').first();

  const box = await target.boundingBox();
  if (!box) throw new Error('terminal target has no bounding box');

  const before = await readMetrics(page);
  console.log('Before:', before);

  await page.screenshot({ path: path.join(OUT_DIR, '01-before-scroll.png'), fullPage: true });
  await target.screenshot({ path: path.join(OUT_DIR, '02-terminal-before.png') });

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.55;

  console.log(`CDP touch drag from (${cx.toFixed(0)}, ${cy.toFixed(0)}) deltaY=-220`);
  await cdpTouchDrag(page, cx, cy, -220);
  await page.waitForTimeout(500);

  const afterUp = await readMetrics(page);
  console.log('After finger-up drag:', afterUp);

  await page.screenshot({ path: path.join(OUT_DIR, '03-after-finger-up.png'), fullPage: true });
  await target.screenshot({ path: path.join(OUT_DIR, '04-terminal-after-finger-up.png') });

  await cdpTouchDrag(page, cx, cy, 220);
  await page.waitForTimeout(500);

  const afterDown = await readMetrics(page);
  console.log('After finger-down drag:', afterDown);

  await page.screenshot({ path: path.join(OUT_DIR, '05-after-finger-down.png'), fullPage: true });
  await target.screenshot({ path: path.join(OUT_DIR, '06-terminal-after-finger-down.png') });

  const domInfo = await page.evaluate(() => {
    const area = document.querySelector('.xterm-scroll-area') as HTMLElement | null;
    const rows = document.querySelector('.xterm-rows');
    return {
      scrollAreaStyleHeight: area?.style.height ?? null,
      scrollAreaOffsetHeight: area?.offsetHeight ?? null,
      rowCount: rows?.children.length ?? 0,
      rowTextLen: rows?.textContent?.length ?? 0,
    };
  });
  console.log('DOM:', domInfo);

  // Control: programmatic scroll — does the viewport move at all?
  const programmatic = await page.evaluate(() => {
    const viewport = document.querySelector('.xterm-viewport') as HTMLElement;
    const before = viewport.scrollTop;
    viewport.scrollTop = Math.min(200, viewport.scrollHeight - viewport.clientHeight);
    return {
      before,
      after: viewport.scrollTop,
      max: viewport.scrollHeight - viewport.clientHeight,
    };
  });
  console.log('Programmatic scroll:', programmatic);
  await page.waitForTimeout(300);
  await target.screenshot({ path: path.join(OUT_DIR, '07-after-programmatic-scroll.png') });

  const scrolledUp = !!before && !!afterUp && afterUp.scrollTop > before.scrollTop;
  const programmaticWorked = programmatic.after > programmatic.before;
  const docStable =
    !!before &&
    !!afterUp &&
    !!afterDown &&
    before.docScroll === 0 &&
    afterUp.docScroll === 0 &&
    afterDown.docScroll === 0;

  console.log('\n--- Result ---');
  console.log(
    `scrollTop changed on finger-up drag: ${scrolledUp} (${before?.scrollTop} → ${afterUp?.scrollTop})`,
  );
  console.log(`programmatic scroll worked: ${programmaticWorked}`);
  console.log(`document scroll stayed 0: ${docStable}`);
  console.log(`Screenshots: ${OUT_DIR}`);

  await browser.close();

  if (!scrolledUp) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
