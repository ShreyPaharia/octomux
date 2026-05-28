import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';

interface RejectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReject: (why?: string) => Promise<void>;
}

export function RejectDialog({ open, onOpenChange, onReject }: RejectDialogProps) {
  const [why, setWhy] = useState('');
  const [rejecting, setRejecting] = useState(false);

  async function handleReject(withWhy: boolean) {
    setRejecting(true);
    try {
      await onReject(withWhy && why.trim() ? why.trim() : undefined);
      setWhy('');
    } finally {
      setRejecting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject comment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Optionally explain why this comment was rejected. This will be saved as a learning to
            improve future reviews.
          </p>
          <Textarea
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="e.g. we intentionally do this because…"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleReject(false)} disabled={rejecting}>
            Reject only
          </Button>
          <Button
            variant="destructive"
            onClick={() => handleReject(true)}
            disabled={rejecting || !why.trim()}
          >
            Reject + remember this
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
