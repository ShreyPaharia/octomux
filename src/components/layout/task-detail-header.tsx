import type { ReactNode } from 'react';

import { StatusBadge } from '@/components/StatusBadge';
import { ClipboardCheckIcon, PullRequestIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { cn } from '@/lib/utils';
import type { RunMode, Task } from '../../../server/types';

const MODE_LABEL: Record<RunMode, string> = {
  new: 'N',
  existing: 'E',
  none: 'Ø',
  scratch: 'S',
};

const MODE_TOOLTIP: Record<RunMode, string> = {
  new: 'new worktree',
  existing: 'attached existing',
  none: 'in-place (no worktree)',
  scratch: 'scratch',
};

export interface TaskDetailHeaderProps {
  task: Task;
  mode: 'agents' | 'editor' | 'diff' | 'info';
  canResume: boolean;
  resuming: boolean;
  canShowDiff: boolean;
  isRunning: boolean;
  isDraft: boolean;
  closeConfirm: boolean;
  /** Disable the Review trigger (e.g. source task is still a draft). */
  reviewDisabled: boolean;
  /** Existing review task id for this source — flips Review → Open review. */
  existingReviewId: string | null;
  /** Manual-review trigger in-flight. */
  reviewBusy: boolean;
  onResume: () => void;
  onShip: () => void;
  onToggleEditor: () => void;
  onModeChange: (mode: 'agents' | 'editor' | 'diff' | 'info') => void;
  onStart: () => void;
  onCloseConfirm: () => void;
  onCloseAccept: () => void;
  onCloseDismiss: () => void;
  onReview: () => void;
}

export function TaskDetailHeader({
  task,
  mode,
  canResume,
  resuming,
  canShowDiff,
  isRunning,
  isDraft,
  closeConfirm,
  reviewDisabled,
  existingReviewId,
  reviewBusy,
  onResume,
  onShip,
  onToggleEditor,
  onModeChange,
  onStart,
  onCloseConfirm,
  onCloseAccept,
  onCloseDismiss,
  onReview,
}: TaskDetailHeaderProps) {
  const runMode: RunMode = task.run_mode ?? 'new';

  return (
    <GlassPanel
      chrome
      data-testid="task-detail-header"
      className="flex shrink-0 items-center justify-between gap-3 rounded-none border-x-0 border-t-0 px-6 py-4"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <h1
          title={task.title}
          aria-label={task.title}
          className="truncate font-display text-lg font-semibold leading-tight tracking-tight text-foreground"
        >
          {task.title}
        </h1>
        <span
          data-testid="mode-badge"
          title={MODE_TOOLTIP[runMode]}
          aria-label={`run mode: ${MODE_TOOLTIP[runMode]}`}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-input bg-secondary px-1.5 font-mono text-[10px] font-bold text-muted-soft"
        >
          {MODE_LABEL[runMode]}
        </span>
        <StatusBadge status={task.derived_status || task.runtime_state} />
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:gap-2">
        {canResume && (
          <Button
            variant="default"
            size="sm"
            className="btn-primary-glow"
            disabled={resuming}
            onClick={onResume}
          >
            {resuming ? '…' : 'Resume'}
          </Button>
        )}

        {canShowDiff && (
          <Button
            size="sm"
            data-testid="ship-button"
            onClick={onShip}
            className="gap-1.5 border border-success/40 bg-success/10 text-green-100 hover:bg-success/20"
          >
            <PullRequestIcon size={14} aria-hidden />
            Ship
          </Button>
        )}

        {task.runtime_state !== 'error' && task.source !== 'auto_review' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="review-button"
            disabled={reviewDisabled || reviewBusy}
            title={reviewDisabled ? 'Start the task first' : undefined}
            className="gap-1.5"
            onClick={onReview}
          >
            <ClipboardCheckIcon size={14} aria-hidden />
            {existingReviewId ? 'Open review' : 'Review'}
          </Button>
        )}

        {isRunning && !!task.tmux_session && (
          <ToolbarButton active={mode === 'editor'} onClick={onToggleEditor}>
            Editor
          </ToolbarButton>
        )}

        {canShowDiff && (
          <ToolbarButton
            active={mode === 'diff'}
            testId="diff-toggle"
            onClick={() => onModeChange(mode === 'diff' ? 'agents' : 'diff')}
          >
            Diff
          </ToolbarButton>
        )}

        {!isDraft && (
          <ToolbarButton
            active={mode === 'info'}
            testId="info-toggle"
            onClick={() => onModeChange(mode === 'info' ? 'agents' : 'info')}
          >
            Info
          </ToolbarButton>
        )}

        {isDraft && (
          <Button variant="default" size="sm" className="btn-primary-glow" onClick={onStart}>
            Start
          </Button>
        )}

        {isRunning &&
          (closeConfirm ? (
            <div
              role="alertdialog"
              aria-label="Confirm mark task done"
              data-testid="close-confirm"
              className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-2 py-1 text-xs text-green-100"
            >
              <span className="font-medium">Mark done?</span>
              <button
                type="button"
                className="px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                onClick={onCloseDismiss}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="close-confirm-accept"
                className="rounded-md border border-success/40 bg-success/15 px-1.5 py-0.5 font-medium text-green-100 hover:bg-success/25"
                onClick={onCloseAccept}
              >
                Confirm
              </button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="border-success/40 bg-success/10 text-green-100 hover:bg-success/20"
              onClick={onCloseConfirm}
            >
              Done
            </Button>
          ))}
      </div>
    </GlassPanel>
  );
}

function ToolbarButton({
  children,
  active,
  testId,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid={testId}
      data-active={active ? 'true' : undefined}
      className={cn(
        active
          ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
          : 'border-input text-muted-soft',
      )}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
