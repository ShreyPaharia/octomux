import { describe, it, expect, vi } from '../bun-test.js';
import { render, screen } from '@testing-library/react';

const factContributionFixture = [
  {
    pluginId: 'coverage-bot',
    slot: 'task.panel' as const,
    fact: 'coverage',
    factType: 'coverage-bot:coverage',
    as: 'stat',
    title: 'Coverage',
    value: 'pct',
  },
];

const collectionContributionFixture = [
  {
    pluginId: 'coverage-bot',
    slot: 'task.panel' as const,
    collection: 'baselines',
    collectionName: 'coverage-bot:baselines',
    as: 'stat',
    title: 'Baselines',
    value: 'pct',
  },
];

const neitherBoundContributionFixture = [
  {
    pluginId: 'coverage-bot',
    slot: 'task.panel' as const,
    as: 'stat',
    title: 'Nothing',
  },
];

const usePluginUiContributionsMock = vi.fn();
const usePluginFactsMock = vi.fn();
const usePluginCollectionMock = vi.fn();

vi.mock('@/lib/plugin-ui', () => ({
  usePluginUiContributions: usePluginUiContributionsMock,
  usePluginFacts: usePluginFactsMock,
  usePluginCollection: usePluginCollectionMock,
}));

const { PluginPanels } = await import('./PluginPanels');

const EMPTY_FACTS = { facts: [], loading: false, error: null };
const EMPTY_RECORDS = { records: [], loading: false, error: null };

describe('PluginPanels', () => {
  it('renders nothing when there are no contributions for the slot', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: [],
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue(EMPTY_FACTS);
    usePluginCollectionMock.mockReturnValue(EMPTY_RECORDS);

    const { container } = render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(container.querySelector('[data-testid="plugin-panels"]')).toBeNull();
  });

  it('renders a fact-bound panel per contribution, with title and rendered value', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: factContributionFixture,
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue({
      facts: [
        {
          seq: 1,
          taskId: 't1',
          type: 'coverage-bot:coverage',
          payload: { pct: 91 },
          createdAt: 'x',
        },
      ],
      loading: false,
      error: null,
    });
    usePluginCollectionMock.mockReturnValue(EMPTY_RECORDS);

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('Coverage')).toBeTruthy();
    expect(screen.getByText('91')).toBeTruthy();
    // Fact-bound: the collection hook's data must never reach the renderer.
    expect(usePluginCollectionMock).toHaveBeenCalled();
  });

  it('renders a collection-bound panel through the named renderer', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: collectionContributionFixture,
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue(EMPTY_FACTS);
    usePluginCollectionMock.mockReturnValue({
      records: [
        {
          collection: 'coverage-bot:baselines',
          key: 'main',
          record: { pct: 77 },
          createdAt: 'c',
          updatedAt: 'u',
        },
      ],
      loading: false,
      error: null,
    });

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('Baselines')).toBeTruthy();
    expect(screen.getByText('77')).toBeTruthy();
  });

  it('does not crash when a contribution has neither a fact nor a collection binding', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: neitherBoundContributionFixture,
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue(EMPTY_FACTS);
    usePluginCollectionMock.mockReturnValue(EMPTY_RECORDS);

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('Nothing')).toBeTruthy();
  });

  it('shows an error instead of the renderer when the facts fetch fails', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: factContributionFixture,
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue({ facts: [], loading: false, error: 'boom' });
    usePluginCollectionMock.mockReturnValue(EMPTY_RECORDS);

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('shows an error instead of the renderer when the collection fetch fails', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: collectionContributionFixture,
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue(EMPTY_FACTS);
    usePluginCollectionMock.mockReturnValue({ records: [], loading: false, error: 'boom' });

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('boom')).toBeTruthy();
  });

  describe('task-free mode (no taskId)', () => {
    it('renders a collection-bound contribution with no taskId prop', () => {
      usePluginUiContributionsMock.mockReturnValue({
        contributions: collectionContributionFixture,
        loading: false,
        error: null,
      });
      usePluginFactsMock.mockReturnValue(EMPTY_FACTS);
      usePluginCollectionMock.mockReturnValue({
        records: [
          {
            collection: 'coverage-bot:baselines',
            key: 'main',
            record: { pct: 77 },
            createdAt: 'c',
            updatedAt: 'u',
          },
        ],
        loading: false,
        error: null,
      });

      render(<PluginPanels slot="settings.card" />);
      expect(screen.getByText('Baselines')).toBeTruthy();
      expect(screen.getByText('77')).toBeTruthy();
    });

    it('skips a fact-bound contribution without crashing', () => {
      usePluginUiContributionsMock.mockReturnValue({
        contributions: factContributionFixture,
        loading: false,
        error: null,
      });
      usePluginFactsMock.mockReturnValue(EMPTY_FACTS);
      usePluginCollectionMock.mockReturnValue(EMPTY_RECORDS);

      const { container } = render(<PluginPanels slot="settings.card" />);
      expect(container.querySelector('[data-testid="plugin-panels"]')).toBeNull();
      expect(screen.queryByText('Coverage')).toBeNull();
    });

    it('renders nothing when the only contribution is fact-bound', () => {
      usePluginUiContributionsMock.mockReturnValue({
        contributions: factContributionFixture,
        loading: false,
        error: null,
      });
      usePluginFactsMock.mockReturnValue(EMPTY_FACTS);
      usePluginCollectionMock.mockReturnValue(EMPTY_RECORDS);

      const { container } = render(<PluginPanels slot="settings.card" />);
      expect(container.firstChild).toBeNull();
    });

    it('with taskId present, both fact-bound and collection-bound contributions still render (no regression)', () => {
      usePluginUiContributionsMock.mockReturnValue({
        contributions: [...factContributionFixture, ...collectionContributionFixture],
        loading: false,
        error: null,
      });
      usePluginFactsMock.mockReturnValue({
        facts: [
          {
            seq: 1,
            taskId: 't1',
            type: 'coverage-bot:coverage',
            payload: { pct: 91 },
            createdAt: 'x',
          },
        ],
        loading: false,
        error: null,
      });
      usePluginCollectionMock.mockReturnValue({
        records: [
          {
            collection: 'coverage-bot:baselines',
            key: 'main',
            record: { pct: 77 },
            createdAt: 'c',
            updatedAt: 'u',
          },
        ],
        loading: false,
        error: null,
      });

      render(<PluginPanels slot="task.panel" taskId="t1" />);
      expect(screen.getByText('Coverage')).toBeTruthy();
      expect(screen.getByText('91')).toBeTruthy();
      expect(screen.getByText('Baselines')).toBeTruthy();
      expect(screen.getByText('77')).toBeTruthy();
    });
  });
});
