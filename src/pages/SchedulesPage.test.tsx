import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SchedulesPage from './SchedulesPage';
import { renderWithRouter } from '../test-helpers';
import type { ScheduleRow } from '@/lib/api/schedulesApi';

const { taskApiProxy, reviewApiProxy, configApiProxy, loopApiProxy, schedulesApiProxy, apiMock } =
  await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());

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
    cron: '0 7 * * 1-5',
    enabled: 1,
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
          configSchema: {
            type: 'object',
            properties: {
              logCommand: { type: 'string', default: 'gh run list' },
              maxIterations: { type: 'integer', default: 5 },
            },
          },
        },
      ],
    });
    apiMock.getDefaultPrompt.mockResolvedValue({ content: 'Default skill prompt' });
    apiMock.listLoops.mockResolvedValue([]);
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
    await waitFor(() => expect(apiMock.getDefaultPrompt).toHaveBeenCalled());
    await user.click(screen.getByTestId('schedule-submit'));

    await waitFor(() => expect(apiMock.createSchedule).toHaveBeenCalledTimes(1));
    expect(apiMock.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'prod-log-triage',
        repoPath: '/my/repo',
        cron: '0 9 * * 1-5',
        enabled: true,
        prompt: null,
      }),
    );
  });

  it('stores null prompt when create form default is left unchanged', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([]);
    apiMock.getDefaultPrompt.mockResolvedValue({ content: 'Default skill prompt' });
    renderWithRouter(<SchedulesPage />);

    await screen.findByText(/no schedules yet/i);
    await user.type(screen.getByTestId('schedule-repo-path'), '/my/repo');
    await waitFor(() =>
      expect(screen.getByTestId('schedule-prompt-create')).toHaveValue('Default skill prompt'),
    );
    await user.click(screen.getByTestId('schedule-submit'));

    await waitFor(() => expect(apiMock.createSchedule).toHaveBeenCalledTimes(1));
    expect(apiMock.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ prompt: null }));
  });

  it('stores edited prompt when create form prompt is customized', async () => {
    const user = userEvent.setup();
    apiMock.listSchedules.mockResolvedValue([]);
    apiMock.getDefaultPrompt.mockResolvedValue({ content: 'Default skill prompt' });
    renderWithRouter(<SchedulesPage />);

    await screen.findByText(/no schedules yet/i);
    await user.type(screen.getByTestId('schedule-repo-path'), '/my/repo');
    const promptField = await screen.findByTestId('schedule-prompt-create');
    await waitFor(() => expect(promptField).toHaveValue('Default skill prompt'));
    await user.clear(promptField);
    await user.type(promptField, 'Custom triage prompt');
    await user.click(screen.getByTestId('schedule-submit'));

    await waitFor(() => expect(apiMock.createSchedule).toHaveBeenCalledTimes(1));
    expect(apiMock.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Custom triage prompt' }),
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
        expect.objectContaining({ cron: '0 9 * * *', prompt: null }),
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
});
