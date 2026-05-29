import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', async () => {
  const actual = (await vi.importActual('@/lib/api')) as Record<string, unknown>;
  return { ...actual, api: apiProxy };
});

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="monaco-diff">
      <pre data-testid="orig">{original}</pre>
      <pre data-testid="mod">{modified}</pre>
    </div>
  ),
}));

import { DiffViewer } from '../DiffViewer';

beforeEach(() => {
  apiMock.getTaskDiffSummary.mockReset().mockResolvedValue({
    files: [
      { path: 'a.ts', status: 'M', additions: 1, deletions: 0, reviewed: false },
      { path: 'b.ts', status: 'M', additions: 1, deletions: 0, reviewed: false },
      { path: 'c.ts', status: 'M', additions: 1, deletions: 0, reviewed: false },
    ],
    ignoredTruncated: false,
  });
  apiMock.getTaskDiffFile.mockReset().mockResolvedValue({
    oldContent: '',
    newContent: '',
    status: 'M',
    tooLarge: false,
    binary: false,
    isDirectory: false,
  });
});

describe('DiffViewer fileOrder prop', () => {
  it('sorts the file list by the provided fileOrder', async () => {
    const onFilesChange = vi.fn();
    render(
      <DiffViewer
        taskId="t1"
        fileOrder={['c.ts', 'a.ts', 'b.ts']}
        onFilesChange={onFilesChange}
      />,
    );
    await waitFor(() => {
      expect(onFilesChange).toHaveBeenCalledWith(['c.ts', 'a.ts', 'b.ts']);
    });
  });

  it('preserves API order when fileOrder is empty', async () => {
    const onFilesChange = vi.fn();
    render(<DiffViewer taskId="t1" fileOrder={[]} onFilesChange={onFilesChange} />);
    await waitFor(() => {
      expect(onFilesChange).toHaveBeenCalledWith(['a.ts', 'b.ts', 'c.ts']);
    });
  });
});
