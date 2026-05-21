import type { ReactNode } from 'react';
import { Button } from './ui/button.js';

export interface ReviewBaseRefBannerProps {
  baseRef: string;
  baseIsStale: boolean;
  totalCount: number;
  reviewedCount: number;
  onRefresh: () => void;
  onJumpToNextUnreviewed: () => void;
  /** Human-readable description of the current diff range (e.g. "full diff", "commit abc1234"). */
  currentRangeLabel?: string;
  /** Optional slot for the range picker (rendered next to "Refresh base"). */
  rangePicker?: ReactNode;
  /** Optional right-aligned slot for adjacent toolbar controls (e.g. a comments toggle). */
  rightSlot?: ReactNode;
}

export function ReviewBaseRefBanner({
  baseRef,
  baseIsStale,
  totalCount,
  reviewedCount,
  onRefresh,
  onJumpToNextUnreviewed,
  currentRangeLabel,
  rangePicker,
  rightSlot,
}: ReviewBaseRefBannerProps) {
  return (
    <div className="diff-pane-header flex items-center gap-3 px-4 py-2.5 text-xs">
      <span className="text-muted-foreground">
        Diffing against <span className="font-mono text-foreground">{baseRef}</span>
      </span>
      <span aria-hidden="true" className="text-muted-foreground/50">
        ·
      </span>
      <span className="text-muted-foreground">{totalCount} files</span>
      <span aria-hidden="true" className="text-muted-foreground/50">
        ·
      </span>
      <button
        type="button"
        onClick={onJumpToNextUnreviewed}
        className="text-muted-foreground hover:text-foreground"
        aria-label={`${reviewedCount} reviewed (jump to next unreviewed)`}
      >
        {reviewedCount} reviewed
      </button>
      {currentRangeLabel ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span className="text-muted-foreground" data-testid="current-range-label">
            Showing: {currentRangeLabel}
          </span>
        </>
      ) : null}
      <span aria-hidden="true" className="text-muted-foreground/50">
        ·
      </span>
      <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Refresh base">
        Refresh base
      </Button>
      {rangePicker ? <span className="ml-1">{rangePicker}</span> : null}
      {baseIsStale && (
        <span className="ml-auto text-amber-500" role="status">
          ⚠ Using local base (offline)
        </span>
      )}
      {rightSlot ? <span className={baseIsStale ? 'ml-1' : 'ml-auto'}>{rightSlot}</span> : null}
    </div>
  );
}
