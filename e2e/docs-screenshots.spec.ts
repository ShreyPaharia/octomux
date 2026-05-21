/**
 * Captures README marketing screenshots from fictional demo data.
 *
 *   bun run screenshots:docs
 */
import { test } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const SCREENSHOTS_DIR = path.join('assets', 'screenshots');
const DESKTOP = { width: 1920, height: 1080 };
const DEMO_DETAIL_ID = 'demo-detail';

const DEMO_SETTINGS = {
  defaultHarnessId: 'cursor',
  dangerouslySkipPermissions: false,
  editor: 'nvim',
  harnesses: {
    'claude-code': { flags: '' },
    cursor: { model: 'composer-2.5', force: true, flags: '' },
  },
};

const DIFF_SUMMARY = {
  files: [
    {
      path: 'src/auth/invite.ts',
      status: 'modified',
      additions: 48,
      deletions: 6,
      reviewed: true,
    },
    {
      path: 'src/components/InviteModal.tsx',
      status: 'added',
      additions: 112,
      deletions: 0,
      reviewed: false,
    },
    {
      path: 'server/routes/invites.ts',
      status: 'modified',
      additions: 31,
      deletions: 4,
      reviewed: false,
    },
  ],
  base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
  base_ref: 'main',
  base_is_stale: false,
  reviewed_count: 1,
  total_count: 3,
};

const INVITE_TS = `export async function sendInvite(email: string, role: TeamRole) {
  const token = await signInviteToken({ email, role });
  await mailer.send({
    to: email,
    template: 'team-invite',
    vars: { acceptUrl: inviteUrl(token) },
  });
  await audit.log('invite.sent', { email, role });
}`;

const INVITE_MODAL = `export function InviteModal({ workspaceId }: { workspaceId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  return (
    <Dialog title="Invite teammate">
      <EmailField value={email} onChange={setEmail} />
      <RolePicker value={role} onChange={setRole} />
      <Button onClick={() => sendInvite(email, role)}>Send invite</Button>
    </Dialog>
  );
}`;

function fileDiffPayload(relPath: string) {
  if (relPath.includes('InviteModal')) {
    return {
      oldContent: '',
      newContent: INVITE_MODAL,
      status: 'added',
      tooLarge: false,
      binary: false,
      isDirectory: false,
    };
  }
  return {
    oldContent: '// previous impl\n',
    newContent: INVITE_TS,
    status: 'modified',
    tooLarge: false,
    binary: false,
    isDirectory: false,
  };
}

async function shot(
  page: import('@playwright/test').Page,
  name: string,
  opts: { fullPage?: boolean } = {},
) {
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, name),
    fullPage: opts.fullPage ?? false,
  });
}

function mockSettingsApi(page: import('@playwright/test').Page) {
  page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DEMO_SETTINGS),
      });
      return;
    }
    await route.continue();
  });
}

function mockDiffApi(page: import('@playwright/test').Page, taskId: string) {
  const prefix = `/api/tasks/${taskId}/diff`;

  page.route(`**${prefix}**`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    const url = new URL(route.request().url());
    const suffix = url.pathname.includes(prefix)
      ? url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length)
      : '';

    if (!suffix || suffix === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DIFF_SUMMARY),
      });
      return;
    }

    const rel = decodeURIComponent(suffix.replace(/^\//, ''));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fileDiffPayload(rel)),
    });
  });
}

function runDocsPatches() {
  const dbPath = process.env.OCTOMUX_DB_PATH ?? path.join('data', 'docs-demo', 'tasks.db');
  execSync('tsx scripts/patch-docs-screenshots.ts', {
    cwd: process.cwd(),
    env: { ...process.env, OCTOMUX_DB_PATH: path.resolve(dbPath) },
    stdio: 'inherit',
  });
}

test.describe.serial('Docs screenshots', () => {
  test.beforeAll(async ({ request }) => {
    await request.get('http://localhost:7788/api/tasks');
    runDocsPatches();
  });

  test.afterAll(() => {
    try {
      execSync('tmux kill-session -t octomux-agent-demo-detail', { stdio: 'ignore' });
    } catch {
      // session may not exist
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.addInitScript(() => {
      localStorage.setItem('octomux-repo-filter', '');
      localStorage.setItem('octomux-board-show-archived', 'false');
    });
  });

  test('dashboard-hero.png', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="inbox-section-awaiting_reply"]');
    await page.waitForTimeout(800);
    await shot(page, 'dashboard-hero.png');
  });

  test('command-center.png', async ({ page }) => {
    await page.goto('/tasks');
    await page.waitForSelector('text=Command center');
    await page.waitForSelector('[data-testid="board-column-in_progress"]');
    await page.waitForTimeout(600);
    await shot(page, 'command-center.png');
  });

  test('composer-harness.png', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="composer"]');
    await page.getByTestId('harness-picker-trigger').click();
    await page.waitForSelector('[data-testid="harness-picker-popover"]');
    await page.getByTestId('harness-picker-option-cursor').click();
    await page.waitForSelector('[data-testid="harness-picker-trigger"]:has-text("Cursor")');
    await page.waitForTimeout(500);
    await shot(page, 'composer-harness.png');
  });

  test('settings-harnesses.png', async ({ page }) => {
    mockSettingsApi(page);
    await page.goto('/settings');
    await page.getByTestId('settings-nav-coding-agent').click();
    await page.waitForSelector('[data-testid="default-harness-select"]');
    await page.waitForSelector('[data-testid="cursor-model-input"]');
    await page.waitForTimeout(600);
    await shot(page, 'settings-harnesses.png');
  });

  test('task-detail.png', async ({ page }) => {
    execSync('tsx scripts/patch-docs-screenshots.ts', {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OCTOMUX_DB_PATH: path.resolve(
          process.env.OCTOMUX_DB_PATH ?? path.join('data', 'docs-demo', 'tasks.db'),
        ),
      },
      stdio: 'inherit',
    });
    await page.goto(`/tasks/${DEMO_DETAIL_ID}`);
    await page.waitForSelector('[data-testid="task-detail-header"]');
    await page.getByTestId('task-error-view').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.getByRole('button', { name: 'Agent 1' }).click();
    await page.locator('.xterm').waitFor({ state: 'visible', timeout: 10_000 });
    // Allow xterm websocket to stream the static Claude welcome pane.
    await page.waitForTimeout(2500);
    await shot(page, 'task-detail.png');
  });

  test('diff-review.png', async ({ page }) => {
    mockDiffApi(page, DEMO_DETAIL_ID);
    await page.goto(`/tasks/${DEMO_DETAIL_ID}`);
    await page.waitForSelector('[data-testid="task-detail-header"]');
    await page.getByTestId('task-error-view').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.getByTestId('task-detail-header').getByRole('button', { name: 'Diff' }).click();
    await page.waitForSelector('[data-testid="diff-file-row-src/auth/invite.ts"]');
    await page.getByTestId('diff-file-row-src/auth/invite.ts').click();
    await page.waitForSelector('text=sendInvite', { timeout: 15_000 });
    await page.waitForFunction(
      () => !document.body.textContent?.includes('Loading src/auth/invite.ts'),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(500);
    await shot(page, 'diff-review.png');
  });
});
