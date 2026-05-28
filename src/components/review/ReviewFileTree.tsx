import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { ChevronDownIcon } from '../icons';
import type { InlineCommentDTO } from '@/lib/api';
import type { Walkthrough, WalkthroughFile } from './WalkthroughHeader';

export const OTHER_GROUP_NAME = 'Other';

interface Props {
  files: string[];
  walkthrough: Walkthrough | null;
  comments: InlineCommentDTO[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface RenderGroup {
  name: string;
  summary?: string;
  files: WalkthroughFile[];
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

function buildGroups(files: string[], walkthrough: Walkthrough | null): RenderGroup[] {
  const diffSet = new Set(files);
  const claimed = new Set<string>();
  const groups: RenderGroup[] = [];

  for (const g of walkthrough?.groups ?? []) {
    const present = (g.files ?? []).filter((f) => diffSet.has(f.path));
    if (present.length === 0) continue;
    for (const f of present) claimed.add(f.path);
    groups.push({ name: g.name, summary: g.summary, files: present });
  }

  const orphans = files.filter((p) => !claimed.has(p));
  if (orphans.length > 0) {
    groups.push({
      name: OTHER_GROUP_NAME,
      files: orphans.map((path) => ({ path })),
    });
  }

  return groups;
}

function shortPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function dirPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

interface FileRowProps {
  file: WalkthroughFile;
  selected: boolean;
  counts: FileCounts | undefined;
  onSelect: (path: string) => void;
}

function FileRow({ file, selected, counts, onSelect }: FileRowProps) {
  const open = counts?.open ?? 0;
  const stale = counts?.stale ?? 0;
  const serious = !!counts?.hasSerious;

  return (
    <li>
      <button
        type="button"
        data-testid={`review-file-row-${file.path}`}
        data-selected={selected ? 'true' : undefined}
        onClick={() => onSelect(file.path)}
        className={cn(
          'flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-glass-l2/40',
          selected && 'bg-glass-l2/60',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <code className="truncate font-mono text-foreground">{shortPath(file.path)}</code>
            {file.label && (
              <Badge variant="outline" className="px-1 text-[10px]">
                {file.label}
              </Badge>
            )}
          </span>
          {dirPath(file.path) && (
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {dirPath(file.path)}
            </span>
          )}
          {file.summary && (
            <span className="line-clamp-2 text-[11px] text-muted-foreground">{file.summary}</span>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {open > 0 && (
            <span
              data-testid={`comment-count-${file.path}`}
              data-tone={serious ? 'serious' : 'muted'}
              className={cn(
                'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                serious
                  ? 'bg-destructive/20 text-destructive'
                  : 'bg-glass-l2 text-muted-foreground',
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
      </button>
    </li>
  );
}

export function ReviewFileTree({ files, walkthrough, comments, selectedPath, onSelect }: Props) {
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

  if (groups.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="review-file-tree-empty">
        No files in diff
      </div>
    );
  }

  return (
    <nav data-testid="review-file-tree" className="flex h-full min-h-0 flex-col overflow-y-auto">
      {groups.map((group) => {
        const open = !collapsed.has(group.name);
        return (
          <section
            key={group.name}
            data-testid={`review-file-group-${group.name}`}
            className="border-b border-glass-edge/60"
          >
            <button
              type="button"
              onClick={() => toggle(group.name)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold hover:bg-glass-l2/40"
              aria-expanded={open}
            >
              <ChevronDownIcon
                className={open ? 'transition-transform' : '-rotate-90 transition-transform'}
              />
              <span>{group.name}</span>
              <span className="text-[10px] font-normal text-muted-foreground">
                {group.files.length}
              </span>
              {group.summary && (
                <span className="ml-1 truncate text-[11px] font-normal text-muted-foreground">
                  — {group.summary}
                </span>
              )}
            </button>
            {open && (
              <ul>
                {group.files.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    selected={selectedPath === f.path}
                    counts={counts.get(f.path)}
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
