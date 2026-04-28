import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PreflightConflict } from '@/lib/api';

interface Props {
  open: boolean;
  conflicts: PreflightConflict[];
  targetBranch: string;
  onClose: () => void;
  onResolved: () => void;
  onCloseTask: (taskId: string) => Promise<void>;
}

export function NoneModeConflictDialog({
  open,
  conflicts,
  targetBranch,
  onClose,
  onResolved,
  onCloseTask,
}: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && conflicts.length === 0) onResolved();
  }, [open, conflicts.length, onResolved]);

  const handleClose = async (id: string) => {
    setPending(id);
    setError(null);
    try {
      await onCloseTask(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Other chats are using `{targetBranch}`</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Close them before starting a new chat on this branch.
        </p>
        <ul className="mt-4 space-y-2">
          {conflicts.map((c) => (
            <li key={c.task_id} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {c.title} <span className="text-xs text-muted-foreground">({c.status})</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending === c.task_id}
                onClick={() => handleClose(c.task_id)}
              >
                {pending === c.task_id ? 'Closing…' : 'Close'}
              </Button>
            </li>
          ))}
        </ul>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
