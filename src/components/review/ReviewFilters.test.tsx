import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewFilters, type CommentFilters } from './ReviewFilters';

const defaultFilters: CommentFilters = {
  severity: [],
  bucket: [],
  kind: [],
  showResolved: false,
};

describe('ReviewFilters', () => {
  it('renders severity, bucket and kind buttons', () => {
    render(<ReviewFilters filters={defaultFilters} onChange={() => {}} />);
    expect(screen.getByText('critical')).toBeTruthy();
    expect(screen.getByText('issue')).toBeTruthy();
    expect(screen.getByText('nit')).toBeTruthy();
    expect(screen.getByText('actionable')).toBeTruthy();
    expect(screen.getByText('comment')).toBeTruthy();
    // 'suggestion' appears in both severity and kind — just check at least one exists
    expect(screen.getAllByText('suggestion').length).toBeGreaterThanOrEqual(2);
  });

  it('calls onChange with toggled severity when clicking a severity button', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReviewFilters filters={defaultFilters} onChange={onChange} />);
    await user.click(screen.getByText('issue'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ severity: ['issue'] }));
  });

  it('toggles showResolved when clicking show/hide resolved', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReviewFilters filters={defaultFilters} onChange={onChange} />);
    await user.click(screen.getByText('show resolved'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showResolved: true }));
  });

  it('shows Clear button when filters are active and calls onChange to reset', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ReviewFilters filters={{ ...defaultFilters, severity: ['issue'] }} onChange={onChange} />,
    );
    expect(screen.getByText('Clear')).toBeTruthy();
    await user.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith({
      severity: [],
      bucket: [],
      kind: [],
      showResolved: false,
    });
  });

  it('does not show Clear button when no filters active', () => {
    render(<ReviewFilters filters={defaultFilters} onChange={() => {}} />);
    expect(screen.queryByText('Clear')).toBeNull();
  });
});
