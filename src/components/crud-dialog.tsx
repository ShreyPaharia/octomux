import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GlassButton } from '@/components/ui/glass-button';
import { GlassInput } from '@/components/ui/glass-input';

export interface CreateNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  canSubmit: boolean;
  submitLabel?: string;
  submittingLabel?: string;
}

export function CreateNameDialog({
  open,
  onOpenChange,
  title,
  placeholder,
  value,
  onChange,
  onSubmit,
  submitting,
  canSubmit,
  submitLabel = 'Create',
  submittingLabel = 'Creating…',
}: CreateNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold">{title}</DialogTitle>
        </DialogHeader>
        <GlassInput
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <GlassButton variant="cancel" onClick={() => onOpenChange(false)}>
            Cancel
          </GlassButton>
          <GlassButton onClick={onSubmit} disabled={submitting || !canSubmit}>
            {submitting ? submittingLabel : submitLabel}
          </GlassButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  onConfirm: () => void;
  submitting: boolean;
  confirmLabel?: string;
  submittingLabel?: string;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  submitting,
  confirmLabel = 'Delete',
  submittingLabel = 'Deleting…',
}: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold">{title}</DialogTitle>
          <DialogDescription className="text-xs text-[#b5b5bd]">{description}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <GlassButton variant="cancel" onClick={() => onOpenChange(false)}>
            Cancel
          </GlassButton>
          <GlassButton variant="destructive" onClick={onConfirm} disabled={submitting}>
            {submitting ? submittingLabel : confirmLabel}
          </GlassButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FormDialogActions({
  onCancel,
  onSubmit,
  submitLabel,
  submittingLabel,
  canSubmit = true,
  submitting = false,
  submitVariant = 'primary',
  className,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submittingLabel?: string;
  canSubmit?: boolean;
  submitting?: boolean;
  submitVariant?: 'primary' | 'destructive';
  className?: string;
}) {
  return (
    <div className={className ?? 'flex justify-end gap-2'}>
      <GlassButton variant="cancel" size="inline" onClick={onCancel}>
        Cancel
      </GlassButton>
      <GlassButton
        variant={submitVariant}
        size="inline"
        onClick={onSubmit}
        disabled={!canSubmit || submitting}
      >
        {submitting ? (submittingLabel ?? `${submitLabel}…`) : submitLabel}
      </GlassButton>
    </div>
  );
}
