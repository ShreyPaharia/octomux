import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { WorkflowStatus } from '@octomux/types';

interface MoveWithNoteDialogProps {
  open: boolean;
  targetColumn: WorkflowStatus | null;
  taskTitle: string;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}

const COLUMN_LABELS: Partial<Record<WorkflowStatus, string>> = {
  planned: 'Planned',
  human_review: 'Human Review',
};

export function MoveWithNoteDialog({
  open,
  targetColumn,
  taskTitle,
  onConfirm,
  onCancel,
}: MoveWithNoteDialogProps) {
  const [note, setNote] = useState('');
  const columnLabel = targetColumn ? (COLUMN_LABELS[targetColumn] ?? targetColumn) : '';

  const handleConfirm = () => {
    const trimmed = note.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    setNote('');
  };

  const handleCancel = () => {
    setNote('');
    onCancel();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel();
      }}
    >
      <DialogContent className="sm:max-w-[400px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Move to {columnLabel}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-muted-foreground">
            Add a note explaining why &ldquo;{taskTitle}&rdquo; is being moved to{' '}
            <strong className="text-foreground">{columnLabel}</strong>.
          </p>
          <Textarea
            autoFocus
            placeholder="Describe what needs review or planning…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleConfirm();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                handleCancel();
              }
            }}
            className="min-h-[80px] resize-none text-sm"
          />
          <p className="text-[10px] text-[#4a4a4a]">⌘↵ to submit · Esc to cancel</p>
        </div>
        <DialogFooter className="-mx-5 -mb-5 px-5 py-4">
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!note.trim()}
            onClick={handleConfirm}
            data-testid="move-note-confirm"
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
