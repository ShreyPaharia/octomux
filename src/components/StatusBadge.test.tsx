import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';
import { renderWithRouter, TASK_STATUSES } from '../test-helpers';
import type { TaskStatus } from '../../server/types';

describe('StatusBadge', () => {
  // ─── Renders all statuses ─────────────────────────────────────────────────

  const statusLabels: [TaskStatus, string][] = [
    ['draft', '[DRAFT]'],
    ['setting_up', '[SETTING_UP]'],
    ['running', '[RUNNING]'],
    ['closed', '[CLOSED]'],
    ['error', '[ERROR]'],
  ];

  it.each(statusLabels)('renders "%s" with label "%s"', (status, label) => {
    renderWithRouter(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('covers every TaskStatus value', () => {
    const testedStatuses = statusLabels.map(([s]) => s);
    expect(testedStatuses).toEqual(TASK_STATUSES);
  });

  // ─── Visual indicators ────────────────────────────────────────────────────

  it('shows pulse indicator only for running status', () => {
    const { container } = renderWithRouter(<StatusBadge status="running" />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  const nonRunningStatuses = TASK_STATUSES.filter((s) => s !== 'running');

  it.each(nonRunningStatuses)('does not show pulse indicator for "%s"', (status) => {
    const { container } = renderWithRouter(<StatusBadge status={status} />);
    expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument();
  });
});
