import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PreflightConflict } from '@/lib/api';

interface Props {
  open: boolean;
  warnings: PreflightConflict[];
  targetBranch: string;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

export function NoneModeSharedBranchDialog({
  open,
  warnings,
  targetBranch,
  onClose,
  onConfirm,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Other chats are using `{targetBranch}`</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          They share the working tree on this branch — concurrent edits may conflict. You can
          continue, but the agents will see each other's changes.
        </p>
        <ul className="mt-4 space-y-1">
          {warnings.map((w) => (
            <li key={w.task_id} className="truncate text-sm">
              {w.title} <span className="text-xs text-muted-foreground">({w.status})</span>
            </li>
          ))}
        </ul>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={busy}>
            {busy ? 'Starting…' : 'Continue anyway'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
