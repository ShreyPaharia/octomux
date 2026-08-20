import { describe, it, expect, vi } from '../bun-test.js';
import { render, screen } from '@testing-library/react';

const contributionsFixture = [
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

const usePluginUiContributionsMock = vi.fn();
const usePluginFactsMock = vi.fn();

vi.mock('@/lib/plugin-ui', () => ({
  usePluginUiContributions: usePluginUiContributionsMock,
  usePluginFacts: usePluginFactsMock,
}));

const { PluginPanels } = await import('./PluginPanels');

describe('PluginPanels', () => {
  it('renders nothing when there are no contributions for the slot', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: [],
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue({ facts: [], loading: false, error: null });

    const { container } = render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(container.querySelector('[data-testid="plugin-panels"]')).toBeNull();
  });

  it('renders a panel per contribution, with title and rendered value', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: contributionsFixture,
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

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('Coverage')).toBeTruthy();
    expect(screen.getByText('91')).toBeTruthy();
  });

  it('shows an error instead of the renderer when the facts fetch fails', () => {
    usePluginUiContributionsMock.mockReturnValue({
      contributions: contributionsFixture,
      loading: false,
      error: null,
    });
    usePluginFactsMock.mockReturnValue({ facts: [], loading: false, error: 'boom' });

    render(<PluginPanels slot="task.panel" taskId="t1" />);
    expect(screen.getByText('boom')).toBeTruthy();
  });
});
