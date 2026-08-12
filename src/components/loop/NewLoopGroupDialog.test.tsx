import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '@/test-helpers';
import { NewLoopGroupDialog } from './NewLoopGroupDialog';

vi.mock('@/lib/api/runApi', () => ({
  runApi: { startLoopGroup: vi.fn() },
}));
vi.mock('@/components/fields/RepoPickerField', () => ({
  RepoPickerField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="repo-field" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('@/components/fields/BranchPickerField', () => ({
  BranchPickerField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="branch-field" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

describe('NewLoopGroupDialog', () => {
  it('submits repo/branch/spec/n and calls onCreated with the result', async () => {
    const { runApi } = await import('@/lib/api/runApi');
    const result = { id: 'run-group-1', loopGroup: { id: 'group-1', n: 3, candidates: [] } };
    vi.mocked(runApi.startLoopGroup).mockResolvedValue(result as never);
    const onCreated = vi.fn();
    const user = userEvent.setup();

    renderWithRouter(<NewLoopGroupDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);

    await user.type(screen.getByTestId('repo-field'), '/repo');
    await user.type(screen.getByTestId('branch-field'), 'main');
    await user.type(screen.getByTestId('loop-group-prompt'), 'improve X');
    await user.type(screen.getByTestId('loop-group-verify'), 'true');
    await user.click(screen.getByTestId('new-loop-group-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
    expect(runApi.startLoopGroup).toHaveBeenCalledWith({
      repoPath: '/repo',
      baseBranch: 'main',
      spec: { prompt: 'improve X', verify: 'true', maxIterations: 10 },
      n: 3,
    });
  });

  it('disables submit until repo, branch, prompt, and verify are all filled', () => {
    renderWithRouter(<NewLoopGroupDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByTestId('new-loop-group-submit')).toBeDisabled();
  });
});
