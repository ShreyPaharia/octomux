import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskPickerField } from './TaskPickerField';
import { makeTask, renderWithRouter } from '../../test-helpers';

const mockTasks = [
  makeTask({ id: 'abc123456789', title: 'Fix login bug', status: 'running' }),
  makeTask({ id: 'def987654321', title: 'Add auth middleware', status: 'closed' }),
  makeTask({ id: 'ghi111222333', title: 'Draft task', status: 'draft' }),
];

vi.mock('@/lib/api', async () => {
  const { makeTask: mt } = await import('../../test-helpers');
  const tasks = [
    mt({ id: 'abc123456789', title: 'Fix login bug', status: 'running' }),
    mt({ id: 'def987654321', title: 'Add auth middleware', status: 'closed' }),
    mt({ id: 'ghi111222333', title: 'Draft task', status: 'draft' }),
  ];
  return {
    api: {
      listTasks: vi.fn().mockResolvedValue(tasks),
    },
  };
});

describe('TaskPickerField', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('shows placeholder when no task selected', () => {
    renderWithRouter(<TaskPickerField value="" onChange={onChange} />);
    expect(screen.getByText('Select task...')).toBeInTheDocument();
  });

  it('shows selected task title when value is set', async () => {
    renderWithRouter(<TaskPickerField value="abc123456789" onChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    });
  });

  it('filters out draft/error/setting_up tasks from dropdown', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TaskPickerField value="" onChange={onChange} />);

    // Open the dropdown
    await user.click(screen.getByText('Select task...'));

    // Wait for tasks to load and verify only running/closed are shown
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
      expect(screen.getByText('Add auth middleware')).toBeInTheDocument();
    });

    // Draft task should not appear
    expect(screen.queryByText('Draft task')).not.toBeInTheDocument();
  });
});
