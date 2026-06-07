import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function ConfirmDeleteReviewDialog({
  open,
  onOpenChange,
  reviewLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewLabel: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="confirm-delete-review" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete review?</DialogTitle>
          <DialogDescription>
            This removes <span className="font-medium text-foreground">{reviewLabel}</span> from
            your reviews inbox. Draft comments and walkthrough data for this PR will be discarded.
            You can start a new review later from GitHub.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-review-confirm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
