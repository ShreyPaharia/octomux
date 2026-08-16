import { describe, it, expect, vi } from '../../bun-test.js';

vi.mock('@/lib/api/taskApi', () => ({
  taskApi: {
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
  },
}));

const { screen } = await import('@testing-library/react');
const { BranchPickerField } = await import('./BranchPickerField');
const { renderWithRouter } = await import('../../test-helpers');

describe('BranchPickerField', () => {
  it('shows disabled state when no repo', () => {
    renderWithRouter(<BranchPickerField repoPath="" value="" onChange={vi.fn()} disabled />);
    const trigger = screen.getByRole('button', { name: /select base branch/i });
    expect(trigger).toBeDisabled();
  });

  it('renders with a selected branch value', () => {
    renderWithRouter(<BranchPickerField repoPath="/some/repo" value="main" onChange={vi.fn()} />);
    expect(screen.getByText('main')).toBeInTheDocument();
  });
});
