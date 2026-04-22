import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

// Monaco's DiffEditor does real DOM work; replace with a stub that exposes
// the original/modified content as testids.
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="monaco-diff">
      <pre data-testid="orig">{original}</pre>
      <pre data-testid="mod">{modified}</pre>
    </div>
  ),
}));

import { DiffViewer } from './DiffViewer';

beforeEach(() => {
  // Reset mocks to their test-helpers defaults so cross-test state doesn't leak
  apiMock.getTaskDiffSummary.mockResolvedValue({ files: [] });
  apiMock.getTaskDiffFile.mockResolvedValue({
    oldContent: '',
    newContent: '',
    status: 'M',
    tooLarge: false,
    binary: false,
  });
});

describe('DiffViewer', () => {
  it('shows empty state when no files changed', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({ files: [] });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => {
      expect(screen.getByText(/no changes/i)).toBeInTheDocument();
    });
  });

  it('renders file tree and loads first file in Monaco', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 1 }],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: 'old',
      newContent: 'new',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('monaco-diff')).toBeInTheDocument());
    expect(screen.getByTestId('orig')).toHaveTextContent('old');
    expect(screen.getByTestId('mod')).toHaveTextContent('new');
  });

  it('shows "too large" message for oversized files', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'big.bin', status: 'M', additions: 0, deletions: 0 }],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: '',
      newContent: '',
      status: 'M',
      tooLarge: true,
      binary: false,
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText(/too large/i)).toBeInTheDocument());
  });

  it('switches file when a tree row is clicked', async () => {
    const user = userEvent.setup();
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'b.ts', status: 'A', additions: 5, deletions: 0 },
      ],
    });
    apiMock.getTaskDiffFile
      .mockResolvedValueOnce({
        oldContent: 'a-old',
        newContent: 'a-new',
        status: 'M',
        tooLarge: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        oldContent: '',
        newContent: 'b-new',
        status: 'A',
        tooLarge: false,
        binary: false,
      });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    await user.click(screen.getByText('b.ts'));
    await waitFor(() => expect(screen.getByTestId('mod')).toHaveTextContent('b-new'));
  });
});
