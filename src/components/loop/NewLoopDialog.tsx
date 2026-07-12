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
import { TaskPickerField } from '@/components/fields/TaskPickerField';
import { loopApi, type LoopRun } from '@/lib/api/loopApi';

interface NewLoopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (run: LoopRun) => void;
}

export function NewLoopDialog({ open, onOpenChange, onCreated }: NewLoopDialogProps) {
  const [taskId, setTaskId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [verify, setVerify] = useState('');
  const [maxIterations, setMaxIterations] = useState('10');
  const [budgetTokens, setBudgetTokens] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setTaskId('');
    setPrompt('');
    setVerify('');
    setMaxIterations('10');
    setBudgetTokens('');
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
  const canSubmit =
    !submitting &&
    taskId.length > 0 &&
    prompt.trim().length > 0 &&
    verify.trim().length > 0 &&
    Number.isInteger(maxIterationsN) &&
    maxIterationsN >= 1;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const budgetTokensN = Number.parseInt(budgetTokens, 10);
      const run = await loopApi.createLoop(taskId, {
        prompt: prompt.trim(),
        verify: verify.trim(),
        maxIterations: maxIterationsN,
        ...(Number.isInteger(budgetTokensN) && budgetTokensN > 0
          ? { budget: { tokens: budgetTokensN } }
          : {}),
      });
      reset();
      onOpenChange(false);
      onCreated(run);
    } catch (err) {
      setError((err as Error).message || 'Failed to create loop');
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    taskId,
    prompt,
    verify,
    maxIterationsN,
    budgetTokens,
    reset,
    onOpenChange,
    onCreated,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="new-loop-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New loop</DialogTitle>
          <DialogDescription>
            Run a task's agent repeatedly, verifying and auto-committing each iteration until it
            reports done, gets blocked, or hits a limit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Task</Label>
            <TaskPickerField value={taskId} onChange={setTaskId} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loop-prompt">Prompt</Label>
            <Textarea
              id="loop-prompt"
              data-testid="loop-prompt"
              rows={4}
              placeholder="What should the agent do each iteration?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loop-verify">Verify command</Label>
            <Input
              id="loop-verify"
              data-testid="loop-verify"
              className="font-mono text-sm"
              placeholder="bun run test"
              value={verify}
              onChange={(e) => setVerify(e.target.value)}
            />
          </div>

          <div className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="loop-max-iterations">Max iterations</Label>
              <Input
                id="loop-max-iterations"
                data-testid="loop-max-iterations"
                type="number"
                min={1}
                value={maxIterations}
                onChange={(e) => setMaxIterations(e.target.value)}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="loop-budget-tokens">Budget tokens (optional)</Label>
              <Input
                id="loop-budget-tokens"
                data-testid="loop-budget-tokens"
                type="number"
                min={0}
                placeholder="none"
                value={budgetTokens}
                onChange={(e) => setBudgetTokens(e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button data-testid="new-loop-submit" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Starting…' : 'Start loop'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
