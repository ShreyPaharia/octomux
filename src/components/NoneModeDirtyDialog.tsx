import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  count: number;
  currentBranch: string;
  targetBranch: string;
  onClose: () => void;
  onStash: () => Promise<void> | void;
}

export function NoneModeDirtyDialog({
  open,
  count,
  currentBranch,
  targetBranch,
  onClose,
  onStash,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStash = async () => {
    setBusy(true);
    setError(null);
    try {
      await onStash();
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
          <DialogTitle>Uncommitted changes</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          You have {count} uncommitted change{count === 1 ? '' : 's'} on `{currentBranch}`.
          Stash them to switch to `{targetBranch}`, or cancel and resolve manually.
        </p>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleStash} disabled={busy}>
            {busy ? 'Stashing…' : 'Stash and continue'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
