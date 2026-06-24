import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../test-helpers';
import { TaskRefsPanel } from './TaskRefsPanel';
import type { TaskExternalRef } from '../../server/types';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

function makeRef(overrides: Partial<TaskExternalRef> = {}): TaskExternalRef {
  return {
    task_id: 'task-1',
    integration: 'jira',
    ref: 'PROJ-1',
    url: null,
    metadata: null,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('TaskRefsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.addTaskRef.mockResolvedValue(makeRef());
    apiMock.deleteTaskRef.mockResolvedValue(undefined);
    apiMock.getTaskRefs.mockResolvedValue([]);
  });

  it('shows "No integrations linked" when no refs', () => {
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={[]} />);
    expect(screen.getByText('No integrations linked.')).toBeInTheDocument();
  });

  it('renders existing refs from initialRefs', () => {
    const refs = [
      makeRef({ integration: 'jira', ref: 'PROJ-42', url: 'https://jira.example.com/PROJ-42' }),
    ];
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={refs} />);
    expect(screen.getByText('jira')).toBeInTheDocument();
    const refLink = screen.getByRole('link', { name: 'PROJ-42' });
    expect(refLink).toHaveAttribute('href', 'https://jira.example.com/PROJ-42');
  });

  it('renders non-URL refs as plain text', () => {
    const refs = [makeRef({ integration: 'linear', ref: 'LIN-10', url: null })];
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={refs} />);
    // Should be text, not a link
    expect(screen.queryByRole('link', { name: 'LIN-10' })).not.toBeInTheDocument();
    expect(screen.getByText('LIN-10')).toBeInTheDocument();
  });

  it('shows remove button for each ref', () => {
    const refs = [
      makeRef({ integration: 'jira', ref: 'PROJ-1' }),
      makeRef({ integration: 'github', ref: 'PR-5' }),
    ];
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={refs} />);
    expect(screen.getByTestId('remove-ref-jira')).toBeInTheDocument();
    expect(screen.getByTestId('remove-ref-github')).toBeInTheDocument();
  });

  it('calls deleteTaskRef when remove is clicked', async () => {
    const user = userEvent.setup();
    const refs = [makeRef({ integration: 'jira', ref: 'PROJ-1' })];
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={refs} />);

    await user.click(screen.getByTestId('remove-ref-jira'));
    expect(apiMock.deleteTaskRef).toHaveBeenCalledWith('task-1', 'jira');
  });

  it('shows add ref form', () => {
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={[]} />);
    expect(screen.getByTestId('ref-integration-input')).toBeInTheDocument();
    expect(screen.getByTestId('ref-value-input')).toBeInTheDocument();
    expect(screen.getByTestId('ref-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('add-ref-button')).toBeDisabled();
  });

  it('enables add button when integration and ref are filled', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={[]} />);

    await user.type(screen.getByTestId('ref-integration-input'), 'jira');
    await user.type(screen.getByTestId('ref-value-input'), 'PROJ-99');

    expect(screen.getByTestId('add-ref-button')).not.toBeDisabled();
  });

  it('renders Linear chip with team badge when metadata.team_key is present', () => {
    const refs = [
      makeRef({
        integration: 'linear',
        ref: 'BAC-1',
        url: 'https://linear.app/x/issue/BAC-1',
        metadata: { team_key: 'BAC' },
      }),
    ];
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={refs} />);
    expect(screen.getByText('BAC-1')).toBeInTheDocument();
    expect(screen.getByText('BAC')).toBeInTheDocument();
  });

  it('falls back to plain rendering when metadata is null', () => {
    const refs = [makeRef({ integration: 'jira', ref: 'PROJ-1', url: null, metadata: null })];
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={refs} />);
    expect(screen.getByText('PROJ-1')).toBeInTheDocument();
  });

  it('calls addTaskRef and clears form on add', async () => {
    const user = userEvent.setup();
    apiMock.addTaskRef.mockResolvedValue(
      makeRef({ integration: 'jira', ref: 'PROJ-99', url: 'https://example.com' }),
    );
    renderWithRouter(<TaskRefsPanel taskId="task-1" initialRefs={[]} />);

    await user.type(screen.getByTestId('ref-integration-input'), 'jira');
    await user.type(screen.getByTestId('ref-value-input'), 'PROJ-99');
    await user.type(screen.getByTestId('ref-url-input'), 'https://example.com');
    await user.click(screen.getByTestId('add-ref-button'));

    await waitFor(() => {
      expect(apiMock.addTaskRef).toHaveBeenCalledWith('task-1', {
        integration: 'jira',
        ref: 'PROJ-99',
        url: 'https://example.com',
      });
    });

    // Form should be cleared
    await waitFor(() => {
      expect(screen.getByTestId('ref-integration-input')).toHaveValue('');
    });
  });
});
