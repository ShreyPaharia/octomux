import { describe, it, expect, vi } from '../bun-test.js';
import { render, screen } from '@testing-library/react';

const contributionFixture = [
  {
    pluginId: 'coverage-bot',
    slot: 'task.panel' as const,
    record: 'coverage',
    recordStore: 'coverage-bot:coverage',
    as: 'stat',
    title: 'Coverage',
    value: 'pct',
  },
];

const noTitleContributionFixture = [
  {
    pluginId: 'coverage-bot',
    slot: 'task.panel' as const,
    record: 'coverage',
    recordStore: 'coverage-bot:coverage',
    as: 'stat',
  },
];

const usePluginUiContributionsMock = vi.fn();
const usePluginRecordsMock = vi.fn();
// PluginPanels now also mounts <PluginActions> (SHR-257) above the panels —
// stubbed to "no actions" here since these tests are only about the
// read-only panel rendering; PluginActions.test.tsx covers actions.
const usePluginUiActionsMock = vi.fn(() => ({ actions: [], loading: false, error: null }));

vi.mock('@/lib/plugin-ui', () => ({
  usePluginUiContributions: usePluginUiContributionsMock,
  usePluginRecords: usePluginRecordsMock,
  usePluginUiActions: usePluginUiActionsMock,
}));

const { PluginPanels } = await import('./PluginPanels');

const EMPTY_RECORDS = { records: [], loading: false, error: null };

describe('PluginPanels', () => {
  it('renders nothing when there are no contributions for the slot', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: [],
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockReturnValue(EMPTY_RECORDS);

    const { container } = render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(container.querySelector('[data-testid="plugin-panels"]')).toBeNull();
  });

  it('renders a panel from a record store without branching on binding kind', async () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: contributionFixture,
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockReturnValue({
      records: [
        {
          seq: 1,
          store: 'coverage-bot:coverage',
          taskId: 't1',
          key: null,
          payload: { pct: '81%' },
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      loading: false,
      error: null,
    });

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('Coverage')).toBeTruthy();
    expect(await screen.findByText('81%')).toBeInTheDocument();
  });

  it('fetches records scoped to the task when taskId is passed', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: contributionFixture,
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockReturnValue(EMPTY_RECORDS);

    render(<PluginPanels slot="task.panel" taskId="t1" />);

    expect(usePluginRecordsMock).toHaveBeenCalledWith(contributionFixture[0], 't1');
  });

  it('fetches every store unscoped when mounted with no taskId', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: contributionFixture,
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockReturnValue(EMPTY_RECORDS);

    render(<PluginPanels slot="settings.card" />);

    expect(usePluginRecordsMock).toHaveBeenCalledWith(contributionFixture[0], undefined);
  });

  it('renders without a title when the binding declares none', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: noTitleContributionFixture,
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockReturnValue({
      records: [
        {
          seq: 1,
          store: 'coverage-bot:coverage',
          taskId: 't1',
          key: null,
          payload: { value: 42 },
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      loading: false,
      error: null,
    });

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('shows an error instead of the renderer when the fetch fails', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: contributionFixture,
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockReturnValue({ records: [], loading: false, error: 'boom' });

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('shows a loading state while the fetch is in flight with no data yet', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: contributionFixture,
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockReturnValue({ records: [], loading: true, error: null });

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders multiple contributions, each fetching independently', () => {
    const second = {
      pluginId: 'reviewer-bot',
      slot: 'task.panel' as const,
      record: 'status',
      recordStore: 'reviewer-bot:status',
      as: 'badge',
    };
    usePluginUiContributionsMock.mockReturnValue({
      contributions: [contributionFixture[0], second],
      loading: false,
      error: null,
    });
    usePluginRecordsMock.mockImplementation((contribution: { recordStore: string }) => ({
      records: [
        {
          seq: 1,
          store: contribution.recordStore,
          taskId: 't1',
          key: null,
          payload: { pct: 'x', value: 'green' },
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      loading: false,
      error: null,
    }));

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('x')).toBeTruthy();
    expect(screen.getByText('green')).toBeTruthy();
    expect(usePluginRecordsMock).toHaveBeenCalledWith(contributionFixture[0], 't1');
    expect(usePluginRecordsMock).toHaveBeenCalledWith(second, 't1');
  });
});
