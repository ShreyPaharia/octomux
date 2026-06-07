import { test, expect, type Page } from '@playwright/test';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { E2eTaskTracker, waitForStatus } from './helpers';

const execFile = promisify(execFileCb);
const tracker = new E2eTaskTracker();

const SERVER_URL = (process.env.OCTOMUX_URL || 'http://localhost:7777').replace(/\/$/, '');
const API = `${SERVER_URL}/api`;

async function tmuxCapture(session: string, windowIndex: number): Promise<string> {
  const { stdout } = await execFile('tmux', [
    'capture-pane',
    '-t',
    `${session}:${windowIndex}`,
    '-p',
  ]);
  return stdout;
}

async function getTask(page: Page, id: string) {
  const res = await page.request.get(`${API}/tasks/${id}`);
  return (await res.json()) as {
    id: string;
    tmux_session: string;
    agents: { window_index: number }[];
  };
}

async function typeIntoTerminal(page: Page, text: string) {
  const terminal = page.locator('.xterm-screen').first();
  await terminal.waitFor({ state: 'visible', timeout: 10_000 });
  await terminal.click();
  await page.keyboard.type(text, { delay: 20 });
}

test.describe('keystroke routing', () => {
  test.afterEach(async ({ page }) => {
    await tracker.cleanup(page);
  });

  test('keystrokes reach ONLY the active agent window when switching tabs', async ({ page }) => {
    const task = await tracker.create(page, { title: 'Routing Within' });
    await waitForStatus(page, task.id, 'running');

    const addRes = await page.request.post(`${API}/tasks/${task.id}/agents`, { data: {} });
    expect(addRes.ok()).toBeTruthy();

    let detail = await getTask(page, task.id);
    for (let i = 0; i < 20 && detail.agents.length < 2; i++) {
      await page.waitForTimeout(250);
      detail = await getTask(page, task.id);
    }
    expect(detail.agents.length).toBeGreaterThanOrEqual(2);

    const [agent1, agent2] = detail.agents;
    await page.goto(`/tasks/${task.id}`);
    await page.waitForTimeout(2000);

    const typedA = `UNIQUE_AGENT_ONE_${Date.now()}`;
    await page.getByRole('button', { name: 'Agent 1' }).click();
    await page.waitForTimeout(500);
    await typeIntoTerminal(page, typedA);
    await page.waitForTimeout(500);

    const typedB = `UNIQUE_AGENT_TWO_${Date.now()}`;
    await page.getByRole('button', { name: 'Agent 2' }).click();
    await page.waitForTimeout(1500);
    await typeIntoTerminal(page, typedB);
    await page.waitForTimeout(500);

    const paneA = await tmuxCapture(detail.tmux_session, agent1.window_index);
    const paneB = await tmuxCapture(detail.tmux_session, agent2.window_index);

    expect(paneA).toContain(typedA);
    expect(paneA).not.toContain(typedB);

    expect(paneB).toContain(typedB);
    expect(paneB).not.toContain(typedA);
  });

  test('keystrokes reach ONLY the active task across task navigation', async ({ page }) => {
    const taskA = await tracker.create(page, { title: 'Routing Cross A' });
    await waitForStatus(page, taskA.id, 'running');
    const taskB = await tracker.create(page, { title: 'Routing Cross B' });
    await waitForStatus(page, taskB.id, 'running');

    const detailA = await getTask(page, taskA.id);
    const detailB = await getTask(page, taskB.id);

    await page.goto(`/tasks/${taskA.id}`);
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(2000);

    await page.goto(`/tasks/${taskB.id}`);
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(2000);

    await page.goto(`/tasks/${taskA.id}`);
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1500);
    const typedA = `ONLY_IN_TASK_A_${Date.now()}`;
    await typeIntoTerminal(page, typedA);
    await page.waitForTimeout(500);

    await page.goto(`/tasks/${taskB.id}`);
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1500);
    const typedB = `ONLY_IN_TASK_B_${Date.now()}`;
    await typeIntoTerminal(page, typedB);
    await page.waitForTimeout(500);

    const paneA = await tmuxCapture(detailA.tmux_session, detailA.agents[0].window_index);
    const paneB = await tmuxCapture(detailB.tmux_session, detailB.agents[0].window_index);

    expect(paneA).toContain(typedA);
    expect(paneA).not.toContain(typedB);

    expect(paneB).toContain(typedB);
    expect(paneB).not.toContain(typedA);
  });
});
