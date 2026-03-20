import { screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BranchPickerField } from './BranchPickerField';
import { renderWithRouter } from '../../test-helpers';

vi.mock('@/lib/api', () => ({
  api: {
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
  },
}));

describe('BranchPickerField', () => {
  it('shows disabled state when no repo', () => {
    renderWithRouter(
      <BranchPickerField repoPath="" value="" onChange={vi.fn()} disabled />,
    );
    const trigger = screen.getByRole('button', { name: /select base branch/i });
    expect(trigger).toBeDisabled();
  });

  it('renders with a selected branch value', () => {
    renderWithRouter(
      <BranchPickerField repoPath="/some/repo" value="main" onChange={vi.fn()} />,
    );
    expect(screen.getByText('main')).toBeInTheDocument();
  });
});
