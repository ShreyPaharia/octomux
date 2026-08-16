import { describe, it, expect, vi, beforeEach } from '../../bun-test.js';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api/taskApi', () => {
  const actual = vi.importActual('@/lib/api/taskApi') as Record<string, unknown>;
  return { ...actual, taskApi: taskApiProxy };
});
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="monaco-diff">
      <pre data-testid="orig">{original}</pre>
      <pre data-testid="mod">{modified}</pre>
    </div>
  ),
}));

const { render, waitFor } = await import('@testing-library/react');

const { DiffViewer } = await import('../DiffViewer');
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
      <DiffViewer taskId="t1" fileOrder={['c.ts', 'a.ts', 'b.ts']} onFilesChange={onFilesChange} />,
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
