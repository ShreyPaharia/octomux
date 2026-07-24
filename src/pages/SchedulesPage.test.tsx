import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SchedulesPage from './SchedulesPage';
import { renderWithRouter } from '../test-helpers';
import type { ScheduleRow } from '@/lib/api/schedulesApi';

const {
  taskApiProxy,
  reviewApiProxy,
  configApiProxy,
  loopApiProxy,
  schedulesApiProxy,
  schedulesApiMock,
  apiMock,
} = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/api/loopApi', () => ({ loopApi: loopApiProxy }));
vi.mock('@/lib/api/schedulesApi', () => ({ schedulesApi: schedulesApiProxy }));
vi.mock('@/components/fields/RepoPickerField', () => ({
  RepoPickerField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input
      data-testid="schedule-repo-path"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
// TimezoneField uses Intl.supportedValuesOf which is not in JSDOM — mock the component.
vi.mock('@/components/schedules/TimezoneField', () => ({
  TimezoneField: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (v: string) => void;
    label?: string;
  }) => (
    <div>
      <label htmlFor="mock-timezone">{label ?? 'Timezone'}</label>
      <input
        id="mock-timezone"
        data-testid="timezone-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  ),
}));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function makeSchedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched-1',
    kind: 'prod-log-triage',
    repo_path: '/repo',
    name: null,
    cron: '0 7 * * 1-5',
    timezone: null,
    enabled: 1,
    model: null,
    timeout_ms: null,
    last_run_at: null,
    config_json: null,
    prompt: null,
    ...overrides,
  };
}

describe('SchedulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getScheduleKinds.mockResolvedValue({
      kinds: [
        {
          kind: 'prod-log-triage',
          displayName: 'Prod Log Triage',
          execution: 'task',
          promptRequired: false,
          supportsTimeout: false,
          configSchema: {
            type: 'object',
            properties: {
              logCommand: { type: 'string', default: 'gh run list' },
              maxIterations: { type: 'integer', default: 5 },
            },
          },
        },
        {
          kind: 'custom',
          displayName: 'Custom Prompt',
          execution: 'session',
          promptRequired: true,
          supportsTimeout: true,
          configSchema: null,
        },
      ],
    });
    apiMock.listLoops.mockResolvedValue([]);
    // getEffectivePrompt is not in the base schedulesApiMock defaults — add it directly.
    (schedulesApiMock as Record<string, unknown>).getEffectivePrompt = vi.fn().mockResolvedValue({
      content: 'Default prompt content with {{placeholder}}',
      source: 'kind_skill',
    });
  });

  it('shows empty state when no schedules', async () => {
    apiMock.listSchedules.mockResolvedValue([]);
    renderWithRouter(<SchedulesPage />);
    expect(await screen.findByText(/no schedules yet/i)).toBeTruthy();
  });

  it('renders schedule rows with kind, repo, cron', async () => {
    apiMock.listSchedules.mockResolvedValue([
      makeSchedule({ id: 'sched-1', kind: 'prod-log-triage', repo_path: '/repo-a' }),
    ]);
    renderWithRouter(<SchedulesPage />);

    expect(await screen.findByTestId('schedule-row-sched-1')).toBeTruthy();
    expect(screen.getByText('/repo-a')).toBeTruthy();
    expect(screen.getByText('0 7 * * 1-5')).toBeTruthy();
  });

  it('submits the new-schedule form and calls createSchedule', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([]);
    renderWithRouter(<SchedulesPage />);

    await screen.findByText(/no schedules yet/i);

    await user.type(screen.getByTestId('schedule-repo-path'), '/my/repo');
    await user.click(screen.getByTestId('schedule-submit'));

    await waitFor(() => expect(apiMock.createSchedule).toHaveBeenCalledTimes(1));
    expect(apiMock.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'prod-log-triage',
        repoPath: '/my/repo',
        cron: '0 9 * * 1-5',
        enabled: true,
      }),
    );
  });

  it('toggling enabled calls updateSchedule (PATCH)', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([makeSchedule({ id: 'sched-1', enabled: 1 })]);
    renderWithRouter(<SchedulesPage />);

    await screen.findByTestId('schedule-row-sched-1');
    const toggle = screen.getByRole('switch', { name: /toggle prod-log-triage schedule/i });
    await user.click(toggle);

    await waitFor(() =>
      expect(apiMock.updateSchedule).toHaveBeenCalledWith('sched-1', { enabled: false }),
    );
  });

  it('expands a schedule to show its runs, linking to /tasks/:id', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([makeSchedule({ id: 'sched-1' })]);
    apiMock.getScheduleRuns.mockResolvedValue({
      runs: [
        {
          id: 'run-1',
          workflow_kind: 'prod-log-triage',
          trigger: 'cron',
          status: 'done',
          effective_status: 'done',
          schedule_id: 'sched-1',
          task_id: 'task-1',
          loop_run_id: null,
          chat_id: null,
          started_at: '2026-01-01 00:00:00',
        },
      ],
    });

    renderWithRouter(<SchedulesPage />);

    await user.click(await screen.findByTestId('schedule-expand-sched-1'));

    const runLink = await screen.findByText('prod-log-triage · cron');
    await user.click(runLink);

    expect(mockNavigate).toHaveBeenCalledWith('/tasks/task-1');
  });

  it('saves schedule edits from the expanded detail panel', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([makeSchedule({ id: 'sched-1' })]);
    apiMock.getScheduleRuns.mockResolvedValue({ runs: [] });

    renderWithRouter(<SchedulesPage />);
    await user.click(await screen.findByTestId('schedule-expand-sched-1'));

    const presetSelect = await screen.findByTestId('schedule-edit-cron-preset-sched-1');
    await user.selectOptions(presetSelect, 'daily');
    await user.click(screen.getByTestId('schedule-save-sched-1'));

    await waitFor(() =>
      expect(apiMock.updateSchedule).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ cron: '0 9 * * *' }),
      ),
    );
  });

  it('triggers run now from the expanded detail panel', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([makeSchedule({ id: 'sched-1' })]);
    apiMock.getScheduleRuns.mockResolvedValue({ runs: [] });

    renderWithRouter(<SchedulesPage />);
    await user.click(await screen.findByTestId('schedule-expand-sched-1'));
    await user.click(await screen.findByTestId('schedule-run-now-sched-1'));

    await waitFor(() => expect(apiMock.runScheduleNow).toHaveBeenCalledWith('sched-1'));
  });

  it('deletes a schedule via the inline confirm dialog (no window.confirm)', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    apiMock.listSchedules.mockResolvedValue([makeSchedule({ id: 'sched-1' })]);
    renderWithRouter(<SchedulesPage />);

    await user.click(await screen.findByTestId('schedule-delete-sched-1'));
    expect(await screen.findByTestId('confirm-delete-schedule')).toBeTruthy();

    await user.click(screen.getByTestId('confirm-delete-schedule-confirm'));

    await waitFor(() => expect(apiMock.deleteSchedule).toHaveBeenCalledWith('sched-1'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  // ── New behavior tests ────────────────────────────────────────────────────

  it('custom kind: submit disabled when name or prompt is empty', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([]);
    renderWithRouter(<SchedulesPage />);

    await screen.findByText(/no schedules yet/i);

    // Switch to custom kind
    const kindSelect = screen.getByTestId('schedule-kind');
    await user.selectOptions(kindSelect, 'custom');

    // Fill repo but leave name and prompt empty
    await user.type(screen.getByTestId('schedule-repo-path'), '/my/repo');

    const submitBtn = screen.getByTestId('schedule-submit');
    expect(submitBtn).toBeDisabled();
  });

  it('custom kind: submit enabled when name and prompt are filled', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([]);
    renderWithRouter(<SchedulesPage />);

    await screen.findByText(/no schedules yet/i);

    const kindSelect = screen.getByTestId('schedule-kind');
    await user.selectOptions(kindSelect, 'custom');

    await user.type(screen.getByTestId('schedule-repo-path'), '/my/repo');
    await user.type(screen.getByTestId('schedule-name'), 'My daily custom');
    await user.type(screen.getByTestId('schedule-prompt'), 'Do something useful every day.');

    const submitBtn = screen.getByTestId('schedule-submit');
    expect(submitBtn).not.toBeDisabled();
  });

  it('custom kind: createSchedule payload includes name and prompt', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([]);
    renderWithRouter(<SchedulesPage />);

    await screen.findByText(/no schedules yet/i);

    const kindSelect = screen.getByTestId('schedule-kind');
    await user.selectOptions(kindSelect, 'custom');

    await user.type(screen.getByTestId('schedule-repo-path'), '/my/repo');
    await user.type(screen.getByTestId('schedule-name'), 'My custom');
    await user.type(screen.getByTestId('schedule-prompt'), 'Run something.');

    await user.click(screen.getByTestId('schedule-submit'));

    await waitFor(() => expect(apiMock.createSchedule).toHaveBeenCalledTimes(1));
    expect(apiMock.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'custom',
        repoPath: '/my/repo',
        name: 'My custom',
        prompt: 'Run something.',
      }),
    );
  });

  it('advanced disclosure is collapsed by default', async () => {
    apiMock.listSchedules.mockResolvedValue([]);
    renderWithRouter(<SchedulesPage />);

    await screen.findByText(/no schedules yet/i);

    // Advanced <details> summary should exist but content should not be visible by default
    expect(screen.getByText('Advanced')).toBeTruthy();
    // The name input for non-custom should not be immediately visible (inside collapsed details)
    // Note: The details element may not be 'open' by default in tests; we just verify it exists.
    const advancedDetails = screen.getByText('Advanced').closest('details');
    expect(advancedDetails).toBeTruthy();
    expect(advancedDetails?.hasAttribute('open')).toBe(false);
  });

  it('patch payload includes new fields when saving edit panel', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([
      makeSchedule({ id: 'sched-1', kind: 'prod-log-triage', model: null, timeout_ms: null }),
    ]);
    apiMock.getScheduleRuns.mockResolvedValue({ runs: [] });

    renderWithRouter(<SchedulesPage />);
    await user.click(await screen.findByTestId('schedule-expand-sched-1'));

    // Fill in the model field
    const modelInput = await screen.findByTestId('schedule-edit-model-sched-1');
    await user.clear(modelInput);
    await user.type(modelInput, 'claude-opus-4-8');

    await user.click(screen.getByTestId('schedule-save-sched-1'));

    await waitFor(() =>
      expect(apiMock.updateSchedule).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ model: 'claude-opus-4-8' }),
      ),
    );
  });

  it('effective-prompt preview is fetched when prompt override panel is expanded', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([makeSchedule({ id: 'sched-1' })]);
    apiMock.getScheduleRuns.mockResolvedValue({ runs: [] });

    renderWithRouter(<SchedulesPage />);
    await user.click(await screen.findByTestId('schedule-expand-sched-1'));

    // Click the "Override prompt" toggle
    const expandBtn = await screen.findByTestId('prompt-override-expand');
    await user.click(expandBtn);

    await waitFor(() =>
      expect(
        (schedulesApiMock as Record<string, ReturnType<typeof vi.fn>>).getEffectivePrompt,
      ).toHaveBeenCalledWith('sched-1'),
    );
    expect(await screen.findByTestId('prompt-preview')).toBeTruthy();
  });

  it('card title shows name when set, falls back to displayName', async () => {
    apiMock.listSchedules.mockResolvedValue([
      makeSchedule({ id: 'sched-named', name: 'My Named Schedule', kind: 'prod-log-triage' }),
    ]);
    renderWithRouter(<SchedulesPage />);

    await screen.findByTestId('schedule-row-sched-named');
    expect(screen.getByTestId('schedule-expand-sched-named').textContent).toBe('My Named Schedule');
  });

  it('delete dialog shows schedule name + cron, not just kind·repo_path', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([
      makeSchedule({ id: 'sched-1', name: 'My special run', cron: '0 8 * * 1' }),
    ]);
    renderWithRouter(<SchedulesPage />);

    await user.click(await screen.findByTestId('schedule-delete-sched-1'));
    const dialog = await screen.findByTestId('confirm-delete-schedule');
    expect(dialog.textContent).toContain('My special run');
    expect(dialog.textContent).toContain('0 8 * * 1');
  });
});
