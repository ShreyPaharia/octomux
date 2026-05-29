import { useMemo, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { ChevronDownIcon } from '../icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { InlineCommentDTO } from '@/lib/api';
import type { Walkthrough, WalkthroughFile } from './WalkthroughHeader';
import { buildGroups } from '@/lib/review-file-groups';

interface Props {
  files: string[];
  walkthrough: Walkthrough | null;
  comments: InlineCommentDTO[];
  selectedPath: string | null;
  reviewedFiles: Set<string>;
  onToggleReviewed: (path: string, currentlyReviewed: boolean) => void;
  onSelect: (path: string) => void;
}

interface FileCounts {
  open: number;
  stale: number;
  hasSerious: boolean;
}

function countsByFile(comments: InlineCommentDTO[]): Map<string, FileCounts> {
  const m = new Map<string, FileCounts>();
  for (const c of comments) {
    const slot = m.get(c.file_path) ?? { open: 0, stale: 0, hasSerious: false };
    if (c.status === 'stale') {
      slot.stale += 1;
    } else if (c.status !== 'rejected' && c.status !== 'published' && !c.auto_resolved_at) {
      slot.open += 1;
      if (c.severity === 'critical' || c.severity === 'issue') slot.hasSerious = true;
    }
    m.set(c.file_path, slot);
  }
  return m;
}

function shortPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

interface FileRowProps {
  file: WalkthroughFile;
  selected: boolean;
  counts: FileCounts | undefined;
  reviewedFiles: Set<string>;
  onToggleReviewed: (path: string, currentlyReviewed: boolean) => void;
  onSelect: (path: string) => void;
}

function FileRow({
  file,
  selected,
  counts,
  reviewedFiles,
  onToggleReviewed,
  onSelect,
}: FileRowProps) {
  const open = counts?.open ?? 0;
  const stale = counts?.stale ?? 0;
  const serious = !!counts?.hasSerious;
  const isReviewed = reviewedFiles.has(file.path);

  return (
    <li
      data-testid={`review-file-row-${file.path}`}
      data-selected={selected ? 'true' : undefined}
      data-reviewed={isReviewed ? 'true' : 'false'}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-glass-l2/40',
        selected && 'bg-glass-l2/60',
        'data-[reviewed=true]:opacity-60',
      )}
      role="treeitem"
      aria-selected={selected}
    >
      <input
        type="checkbox"
        checked={isReviewed}
        data-testid={`review-toggle-${file.path}`}
        aria-label={isReviewed ? `Unmark ${file.path} reviewed` : `Mark ${file.path} reviewed`}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation();
          onToggleReviewed(file.path, isReviewed);
        }}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer"
      />
      <button
        type="button"
        onClick={() => onSelect(file.path)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        tabIndex={selected ? 0 : -1}
      >
        <code className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.path}>
          {shortPath(file.path)}
        </code>
        {file.label && (
          <Badge variant="outline" className="shrink-0 px-1 text-[10px]">
            {file.label}
          </Badge>
        )}
      </button>
      {file.summary && (
        <Popover>
          <PopoverTrigger
            render={<span />}
            nativeButton={false}
            aria-label={`Summary for ${file.path}`}
            className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            info
          </PopoverTrigger>
          <PopoverContent className="w-72 text-xs">{file.summary}</PopoverContent>
        </Popover>
      )}
      <div className="flex shrink-0 flex-col items-end gap-1">
        {open > 0 && (
          <span
            data-testid={`comment-count-${file.path}`}
            data-tone={serious ? 'serious' : 'muted'}
            className={cn(
              'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              serious ? 'bg-destructive/20 text-destructive' : 'bg-glass-l2 text-muted-foreground',
            )}
          >
            {open}
          </span>
        )}
        {stale > 0 && (
          <span
            data-testid={`stale-count-${file.path}`}
            className="inline-flex items-center rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
          >
            stale: {stale}
          </span>
        )}
      </div>
    </li>
  );
}

export function ReviewFileTree({
  files,
  walkthrough,
  comments,
  selectedPath,
  reviewedFiles,
  onToggleReviewed,
  onSelect,
}: Props) {
  const groups = useMemo(() => buildGroups(files, walkthrough), [files, walkthrough]);
  const counts = useMemo(() => countsByFile(comments), [comments]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (!['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) return;
      const orderedPaths = groups.flatMap((g) => g.files.map((f) => f.path));
      if (orderedPaths.length === 0) return;
      const idx = selectedPath ? orderedPaths.indexOf(selectedPath) : -1;
      const delta = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
      const nextIdx = idx === -1 ? 0 : (idx + delta + orderedPaths.length) % orderedPaths.length;
      const next = orderedPaths[nextIdx];
      if (next) {
        e.preventDefault();
        onSelect(next);
      }
    },
    [groups, selectedPath, onSelect],
  );

  if (groups.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="review-file-tree-empty">
        No files in diff
      </div>
    );
  }

  return (
    <nav
      data-testid="review-file-tree"
      role="tree"
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      onKeyDown={handleKeyDown}
    >
      {groups.map((group) => {
        const open = !collapsed.has(group.name);
        return (
          <section
            key={group.name}
            role="group"
            data-testid={`review-file-group-${group.name}`}
            className="border-b border-glass-edge/60"
          >
            <button
              type="button"
              onClick={() => toggle(group.name)}
              className="flex w-full items-center gap-2 overflow-hidden px-3 py-2 text-left text-xs font-semibold hover:bg-glass-l2/40"
              aria-expanded={open}
              role="treeitem"
              title={group.name}
            >
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  'shrink-0',
                  open ? 'transition-transform' : '-rotate-90 transition-transform',
                )}
              />
              <span className="min-w-0 flex-1 truncate">{group.name}</span>
              <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                {group.files.length}
              </span>
            </button>
            {open && group.summary && (
              <div
                className="line-clamp-1 px-3 pb-1 text-[11px] text-muted-foreground"
                title={group.summary}
              >
                {group.summary}
              </div>
            )}
            {open && (
              <ul>
                {group.files.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    selected={selectedPath === f.path}
                    counts={counts.get(f.path)}
                    reviewedFiles={reviewedFiles}
                    onToggleReviewed={onToggleReviewed}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}
