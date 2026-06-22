/**
 * src/components/orchestrator/ToolCallCard.test.tsx
 *
 * SHR-161 — conductor tool calls render as collapsible cards distinct from
 * prose, with task IDs linking into /tasks/:id.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../../test-helpers';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard (SHR-161)', () => {
  it('shows the tool name and a collapsible details element', () => {
    const { container } = renderWithRouter(
      <ToolCallCard toolName="create_task" input={{ title: 'Build X' }} />,
    );
    expect(screen.getByText('create_task')).toBeInTheDocument();
    expect(container.querySelector('details')).not.toBeNull();
    // summary surfaces the salient arg
    expect(screen.getByText('Build X')).toBeInTheDocument();
  });

  it('links a task_id into /tasks/:id', () => {
    renderWithRouter(<ToolCallCard toolName="send_message" input={{ task_id: 'abc123def456' }} />);
    const link = screen.getByRole('link', { name: 'abc123def456' });
    expect(link).toHaveAttribute('href', '/tasks/abc123def456');
  });

  it('renders the full input as JSON when expanded', () => {
    const { container } = renderWithRouter(
      <ToolCallCard toolName="set_task_status" input={{ task_id: 't1', status: 'done' }} />,
    );
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('"status": "done"');
  });

  it('omits the task link when there is no task_id', () => {
    renderWithRouter(<ToolCallCard toolName="create_task" input={{ title: 'X' }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
