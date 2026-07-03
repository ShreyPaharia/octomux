import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';
import { renderWithRouter, TASK_STATUSES } from '../test-helpers';
import type { RuntimeState } from '@octomux/types';

describe('StatusBadge', () => {
  // ─── Renders all statuses with glyph + label ──────────────────────────────

  const statusLabels: [RuntimeState, string, string][] = [
    ['idle', 'IDLE', '○'],
    ['setting_up', 'SETTING_UP', '◐'],
    ['running', 'RUNNING', '●'],
    ['error', 'ERROR', '✕'],
  ];

  it.each(statusLabels)(
    'renders "%s" with label "%s" prefixed by glyph "%s"',
    (status, label, glyph) => {
      renderWithRouter(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(glyph)).toBeInTheDocument();
    },
  );

  it('covers every TaskStatus value', () => {
    const testedStatuses = statusLabels.map(([s]) => s);
    expect(testedStatuses).toEqual(TASK_STATUSES);
  });

  // ─── Glyph is always present ──────────────────────────────────────────────

  it.each(TASK_STATUSES)('renders a StatusGlyph for "%s"', (status) => {
    const { container } = renderWithRouter(<StatusBadge status={status} />);
    expect(container.querySelector('[role="img"]')).toBeInTheDocument();
  });
});
