import { useMemo } from 'react';
import { Badge } from '../ui/badge';
import { lookupWalkthroughFile, type RenderGroup } from '@/lib/review-file-groups';

function shortPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

interface ReviewContextStripProps {
  groups: RenderGroup[];
  selectedPath: string | null;
}

export function ReviewContextStrip({ groups, selectedPath }: ReviewContextStripProps) {
  const ctx = useMemo(
    () => (selectedPath ? lookupWalkthroughFile(groups, selectedPath) : null),
    [groups, selectedPath],
  );

  const hasNotes = !!(ctx?.file.summary || ctx?.group.summary);

  if (!selectedPath) {
    return (
      <div
        data-testid="review-context-strip"
        className="border-b border-glass-edge bg-glass-l1/50 px-4 py-2 text-[11px] text-muted-foreground"
      >
        Select a file to read its review notes
      </div>
    );
  }

  if (!hasNotes) {
    return (
      <div
        data-testid="review-context-strip"
        className="border-b border-glass-edge bg-glass-l1/50 px-4 py-2 text-[11px] text-muted-foreground"
      >
        <span className="font-mono text-foreground">{shortPath(selectedPath)}</span>
        <span className="ml-2">— no walkthrough notes for this file</span>
      </div>
    );
  }

  return (
    <aside
      data-testid="review-context-strip"
      className="max-h-52 space-y-3 overflow-y-auto border-b border-glass-edge bg-glass-l1/80 px-4 py-3"
    >
      {ctx!.group.summary && (
        <div data-testid="review-context-group">
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {ctx!.group.name}
          </h3>
          <p className="text-xs leading-relaxed text-foreground">{ctx!.group.summary}</p>
        </div>
      )}
      {ctx!.file.summary && (
        <div data-testid="review-context-file">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span
              className="font-mono text-[11px] font-medium text-foreground"
              title={selectedPath}
            >
              {shortPath(selectedPath)}
            </span>
            {ctx!.file.label && (
              <Badge variant="outline" className="px-1 text-[10px]">
                {ctx!.file.label}
              </Badge>
            )}
          </div>
          <p className="text-xs leading-relaxed text-foreground">{ctx!.file.summary}</p>
        </div>
      )}
    </aside>
  );
}
