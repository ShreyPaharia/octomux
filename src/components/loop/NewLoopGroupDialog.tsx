import { useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RepoPickerField } from '@/components/fields/RepoPickerField';
import { BranchPickerField } from '@/components/fields/BranchPickerField';
import { loopGroupApi, type LoopGroupDetail } from '@/lib/api/loopGroupApi';

interface NewLoopGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (group: LoopGroupDetail) => void;
}

const DEFAULT_N = '3';

export function NewLoopGroupDialog({ open, onOpenChange, onCreated }: NewLoopGroupDialogProps) {
  const [repoPath, setRepoPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [verify, setVerify] = useState('');
  const [maxIterations, setMaxIterations] = useState('10');
  const [n, setN] = useState(DEFAULT_N);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setRepoPath('');
    setBaseBranch('');
    setPrompt('');
    setVerify('');
    setMaxIterations('10');
    setN(DEFAULT_N);
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return;
      if (!next) reset();
      onOpenChange(next);
    },
    [submitting, reset, onOpenChange],
  );

  const maxIterationsN = Number.parseInt(maxIterations, 10);
  const nN = Number.parseInt(n, 10);
  const canSubmit =
    !submitting &&
    repoPath.trim().length > 0 &&
    baseBranch.trim().length > 0 &&
    prompt.trim().length > 0 &&
    verify.trim().length > 0 &&
    Number.isInteger(maxIterationsN) &&
    maxIterationsN >= 1 &&
    Number.isInteger(nN) &&
    nN >= 2 &&
    nN <= 8;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const group = await loopGroupApi.createLoopGroup({
        repoPath: repoPath.trim(),
        baseBranch: baseBranch.trim(),
        spec: { prompt: prompt.trim(), verify: verify.trim(), maxIterations: maxIterationsN },
        n: nN,
      });
      reset();
      onOpenChange(false);
      onCreated(group);
    } catch (err) {
      setError((err as Error).message || 'Failed to launch best-of-N');
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    repoPath,
    baseBranch,
    prompt,
    verify,
    maxIterationsN,
    nN,
    reset,
    onOpenChange,
    onCreated,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="new-loop-group-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Best of N</DialogTitle>
          <DialogDescription>
            Launch N parallel candidate loops from the same spec, then judge the winner once all
            finish.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Repo</Label>
            <RepoPickerField value={repoPath} onChange={setRepoPath} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Base branch</Label>
            <BranchPickerField repoPath={repoPath} value={baseBranch} onChange={setBaseBranch} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loop-group-prompt">Prompt</Label>
            <Textarea
              id="loop-group-prompt"
              data-testid="loop-group-prompt"
              rows={4}
              placeholder="What should each candidate try to do?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loop-group-verify">Verify command</Label>
            <Input
              id="loop-group-verify"
              data-testid="loop-group-verify"
              className="font-mono text-sm"
              placeholder="bun run test"
              value={verify}
              onChange={(e) => setVerify(e.target.value)}
            />
          </div>

          <div className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="loop-group-max-iterations">Max iterations</Label>
              <Input
                id="loop-group-max-iterations"
                data-testid="loop-group-max-iterations"
                type="number"
                min={1}
                value={maxIterations}
                onChange={(e) => setMaxIterations(e.target.value)}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="loop-group-n">Candidates (N)</Label>
              <Input
                id="loop-group-n"
                data-testid="loop-group-n"
                type="number"
                min={2}
                max={8}
                value={n}
                onChange={(e) => setN(e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button data-testid="new-loop-group-submit" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Launching…' : 'Launch best of N'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
