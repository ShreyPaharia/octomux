import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataSection } from './data-section';

describe('DataSection', () => {
  it('renders skeleton rows while loading', () => {
    const { container } = render(
      <DataSection loading error={null} isEmpty={false} skeletonRows={2}>
        <div>List</div>
      </DataSection>,
    );
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(2);
    expect(screen.queryByText('List')).not.toBeInTheDocument();
  });

  it('renders error with retry', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <DataSection loading={false} error="boom" onRetry={onRetry} isEmpty={false}>
        <div>List</div>
      </DataSection>,
    );
    expect(screen.getByText('boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders empty state when not loading and no error', () => {
    render(
      <DataSection loading={false} error={null} isEmpty empty={<div>Nothing here</div>}>
        <div>List</div>
      </DataSection>,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByText('List')).not.toBeInTheDocument();
  });

  it('renders children when data is present', () => {
    render(
      <DataSection loading={false} error={null} isEmpty={false}>
        <div>List content</div>
      </DataSection>,
    );
    expect(screen.getByText('List content')).toBeInTheDocument();
  });
});
