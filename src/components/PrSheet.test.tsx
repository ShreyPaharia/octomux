import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrSheet } from './PrSheet';
import { makeTask } from '../test-helpers';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getTaskDiffSummary.mockResolvedValue({
    files: [{ path: 'src/a.ts', status: 'M', additions: 5, deletions: 2 }],
  });
  apiMock.createPr.mockResolvedValue({ ok: true, url: 'https://github.com/x/y/pull/1', number: 1 });
});

describe('PrSheet', () => {
  it('renders pre-filled title and body after fetching diff', async () => {
    const task = makeTask({
      id: 't-1',
      title: 'fix bug',
      branch: 'agents/fix-bug',
      description: 'one-liner description',
    });
    render(<PrSheet open task={task} onClose={() => {}} />);
    const title = screen.getByTestId('pr-sheet-title') as HTMLInputElement;
    expect(title.value).toBe('fix bug');
    await waitFor(() => {
      const body = screen.getByTestId('pr-sheet-body') as HTMLTextAreaElement;
      expect(body.value).toContain('## Summary');
      expect(body.value).toContain('## Changes');
      expect(body.value).toContain('src/a.ts');
      expect(body.value).toContain('## Test plan');
    });
  });

  it('calls taskApi.createPr when Create PR is clicked', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 't-2', title: 'ship it', branch: 'agents/x' });
    render(<PrSheet open task={task} onClose={() => {}} />);
    await waitFor(() => {
      expect(apiMock.getTaskDiffSummary).toHaveBeenCalled();
    });
    await user.click(screen.getByTestId('pr-sheet-submit'));
    await waitFor(() => {
      expect(apiMock.createPr).toHaveBeenCalledWith(
        't-2',
        expect.objectContaining({ title: 'ship it', draft: false }),
      );
    });
  });
});
