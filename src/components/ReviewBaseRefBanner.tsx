import { Button } from './ui/button.js';

export interface ReviewBaseRefBannerProps {
  baseRef: string;
  baseIsStale: boolean;
  totalCount: number;
  reviewedCount: number;
  onRefresh: () => void;
  onJumpToNextUnreviewed: () => void;
}

export function ReviewBaseRefBanner({
  baseRef,
  baseIsStale,
  totalCount,
  reviewedCount,
  onRefresh,
  onJumpToNextUnreviewed,
}: ReviewBaseRefBannerProps) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-xs border-b border-glass-border">
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
      <span aria-hidden="true" className="text-muted-foreground/50">
        ·
      </span>
      <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Refresh base">
        Refresh base
      </Button>
      {baseIsStale && (
        <span className="ml-auto text-amber-500" role="status">
          ⚠ Using local base (offline)
        </span>
      )}
    </div>
  );
}
