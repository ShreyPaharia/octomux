import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RepoPickerField } from './RepoPickerField';
import { renderWithRouter } from '../../test-helpers';

vi.mock('@/lib/api', () => ({
  api: {
    recentRepos: vi.fn().mockResolvedValue([]),
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
  },
}));

describe('RepoPickerField', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
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
});
