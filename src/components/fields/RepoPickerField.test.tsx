import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RepoPickerField } from './RepoPickerField';
import { renderWithRouter } from '../../test-helpers';
import type { RecentRepo } from '@/lib/api';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

function makeRecent(repo_path: string, last_used = '2026-01-01 00:00:00'): RecentRepo {
  return { repo_path, last_used };
}

describe('RepoPickerField', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    apiMock.recentRepos.mockResolvedValue([]);
  });

  it('renders input with placeholder', () => {
    renderWithRouter(<RepoPickerField value="" onChange={onChange} />);
    expect(screen.getByPlaceholderText('/Users/you/projects/my-repo')).toBeInTheDocument();
  });

  it('renders Browse button', () => {
    renderWithRouter(<RepoPickerField value="" onChange={onChange} />);
    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
  });

  it('calls onChange when typing', async () => {
    const user = userEvent.setup();
    renderWithRouter(<RepoPickerField value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText('/Users/you/projects/my-repo');
    await user.type(input, '/tmp');
    expect(onChange).toHaveBeenCalled();
  });

  // ─── Recent repos: basename rendering ──────────────────────────────────

  it('shows basename (not full path) and full path as title tooltip', async () => {
    apiMock.recentRepos.mockResolvedValue([makeRecent('/Users/dev/projects/octomux')]);
    renderWithRouter(<RepoPickerField value="" onChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByTitle('/Users/dev/projects/octomux')).toBeInTheDocument();
    });
    const btn = screen.getByTitle('/Users/dev/projects/octomux');
    expect(btn).toHaveTextContent('octomux');
    expect(btn).not.toHaveTextContent('/Users/dev/projects/octomux');
  });

  it('does not show disambiguation when basenames are unique', async () => {
    apiMock.recentRepos.mockResolvedValue([
      makeRecent('/Users/dev/projects/alpha'),
      makeRecent('/Users/dev/work/beta'),
    ]);
    renderWithRouter(<RepoPickerField value="" onChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByTitle('/Users/dev/projects/alpha')).toBeInTheDocument();
    });
    expect(screen.getByTitle('/Users/dev/projects/alpha')).toHaveTextContent('alpha');
    expect(screen.getByTitle('/Users/dev/projects/alpha')).not.toHaveTextContent('projects');
    expect(screen.getByTitle('/Users/dev/work/beta')).toHaveTextContent('beta');
    expect(screen.getByTitle('/Users/dev/work/beta')).not.toHaveTextContent('work');
  });

  it('shows "name · parent" disambiguation when two basenames collide', async () => {
    apiMock.recentRepos.mockResolvedValue([
      makeRecent('/Users/dev/projects/octomux'),
      makeRecent('/Users/dev/work/octomux'),
    ]);
    renderWithRouter(<RepoPickerField value="" onChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByTitle('/Users/dev/projects/octomux')).toBeInTheDocument();
    });
    const firstBtn = screen.getByTitle('/Users/dev/projects/octomux');
    const secondBtn = screen.getByTitle('/Users/dev/work/octomux');
    expect(firstBtn).toHaveTextContent('octomux');
    expect(firstBtn).toHaveTextContent('projects');
    expect(secondBtn).toHaveTextContent('octomux');
    expect(secondBtn).toHaveTextContent('work');
  });
});
