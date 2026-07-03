import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinearConfigForm } from './LinearConfigForm.js';
import { configApi } from '@/lib/api/configApi';

vi.mock('@/lib/api/configApi', () => ({
  configApi: {
    prefillLinear: vi.fn(),
  },
}));

describe('LinearConfigForm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an empty form by default', () => {
    render(<LinearConfigForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect.*auto-detect/i })).toBeInTheDocument();
  });

  it('calls prefillLinear when Connect & auto-detect is clicked, then shows team rows', async () => {
    (configApi.prefillLinear as any).mockResolvedValue({
      teams: [
        {
          id: 'team-bac',
          key: 'BAC',
          name: 'Backend',
          states: [
            { id: 's-backlog', name: 'Backlog', type: 'backlog' },
            { id: 's-done', name: 'Done', type: 'completed' },
          ],
        },
      ],
      status_map_by_team: { BAC: { backlog: 's-backlog', done: 's-done' } },
      default_team_suggestion: 'BAC',
    });

    const user = userEvent.setup();
    render(<LinearConfigForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/api key/i), 'lin_xyz');
    await user.click(screen.getByRole('button', { name: /connect.*auto-detect/i }));

    expect(configApi.prefillLinear).toHaveBeenCalledWith('lin_xyz');
    const matches = await screen.findAllByText(/Backend \(BAC\)/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('submits the full config including status_map_by_team and default_team_key', async () => {
    (configApi.prefillLinear as any).mockResolvedValue({
      teams: [
        {
          id: 'team-bac',
          key: 'BAC',
          name: 'Backend',
          states: [{ id: 's-done', name: 'Done', type: 'completed' }],
        },
      ],
      status_map_by_team: { BAC: { done: 's-done' } },
      default_team_suggestion: 'BAC',
    });

    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<LinearConfigForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/api key/i), 'lin_xyz');
    await user.click(screen.getByRole('button', { name: /connect.*auto-detect/i }));
    expect(await screen.findAllByText(/Backend \(BAC\)/i)).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key: 'lin_xyz',
        default_team_key: 'BAC',
        status_map_by_team: { BAC: { done: 's-done' } },
      }),
      expect.any(String), // integration name
    );
  });
});
