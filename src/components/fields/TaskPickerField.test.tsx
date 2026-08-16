import { describe, it, expect, vi, beforeEach } from '../../bun-test.js';

vi.mock('@/lib/api/taskApi', () => {
  const { makeTask: mt } =
    vi.importActual<typeof import('../../test-helpers')>('../../test-helpers');
  const tasks = [
    mt({ id: 'abc123456789', title: 'Fix login bug', runtime_state: 'running' }),
    mt({ id: 'def987654321', title: 'Add auth middleware', runtime_state: 'idle' }),
    mt({ id: 'ghi111222333', title: 'Draft task', runtime_state: 'error' }),
  ];
  return {
    taskApi: {
      listTasks: vi.fn().mockResolvedValue(tasks),
    },
  };
});

const { screen, waitFor } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { TaskPickerField } = await import('./TaskPickerField');
const { renderWithRouter } = await import('../../test-helpers');

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
