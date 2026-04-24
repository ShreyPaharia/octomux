import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { DiffFileEntry } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@/components/icons';

interface Props {
  files: DiffFileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  taskId?: string;
  ignoredTruncated?: boolean;
  reviewed?: Set<string>;
  onToggleReview?: (path: string) => void;
}

export function ignoredGroupKey(taskId: string): string {
  return `octomux:diff-ignored-open:${taskId}`;
}

interface Node {
  name: string;
  fullPath: string;
  isFile: boolean;
  file?: DiffFileEntry;
  children?: Map<string, Node>;
}

function buildTree(files: DiffFileEntry[]): Node {
  const root: Node = { name: '', fullPath: '', isFile: false, children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (!cur.children) cur.children = new Map();
      let next = cur.children.get(part);
      if (!next) {
        next = {
          name: part,
          fullPath: parts.slice(0, i + 1).join('/'),
          isFile: isLast,
          file: isLast ? f : undefined,
          children: isLast ? undefined : new Map(),
        };
        cur.children.set(part, next);
      }
      cur = next;
    }
  }
  return root;
}

const statusColor: Record<string, string> = {
  A: 'text-green-500',
  M: 'text-yellow-500',
  D: 'text-red-500',
  B: 'text-muted-foreground',
};

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
  reviewed,
  onToggleReview,
}: {
  node: Node;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  reviewed?: Set<string>;
  onToggleReview?: (path: string) => void;
}) {
  if (node.isFile && node.file) {
    const f = node.file;
    const active = selected === f.path;
    const isReviewed = reviewed?.has(f.path) ?? false;
    const handleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'r' && onToggleReview && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        onToggleReview(f.path);
      }
    };
    return (
      <button
        type="button"
        data-testid={`diff-file-row-${f.path}`}
        data-reviewed={isReviewed ? 'true' : undefined}
        onClick={() => onSelect(f.path)}
        onKeyDown={handleKey}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent',
          active && 'bg-accent',
          isReviewed && 'opacity-50',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {onToggleReview ? (
          <span
            role="checkbox"
            aria-checked={isReviewed}
            aria-label={isReviewed ? `Unmark ${f.path} as reviewed` : `Mark ${f.path} as reviewed`}
            data-testid={`review-toggle-${f.path}`}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onToggleReview(f.path);
            }}
            className={cn(
              'inline-flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center border',
              isReviewed
                ? 'border-[#22C55E] bg-[#22C55E33] text-[#22C55E]'
                : 'border-[#2f2f2f] bg-transparent text-transparent hover:border-[#6a6a6a]',
            )}
          >
            {isReviewed ? <CheckIcon size={10} /> : null}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className={cn('font-mono text-[10px] font-bold', statusColor[f.status])}>
            {f.status}
          </span>
          <span className="truncate">{node.name}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          <span className="text-green-500">+{f.additions}</span>
          <span className="text-muted-foreground"> / </span>
          <span className="text-red-500">-{f.deletions}</span>
        </span>
      </button>
    );
  }
  const children = node.children ? Array.from(node.children.values()) : [];
  children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return (
    <>
      {node.name && (
        <div
          data-testid={`diff-group-${node.fullPath}`}
          className="px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {node.name}
        </div>
      )}
      {children.map((child) => (
        <TreeRow
          key={child.fullPath}
          node={child}
          depth={node.name ? depth + 1 : depth}
          selected={selected}
          onSelect={onSelect}
          reviewed={reviewed}
          onToggleReview={onToggleReview}
        />
      ))}
    </>
  );
}

export function DiffFileTree({
  files,
  selected,
  onSelect,
  taskId,
  ignoredTruncated,
  reviewed,
  onToggleReview,
}: Props) {
  const changed = useMemo(() => files.filter((f) => !f.ignored), [files]);
  const ignored = useMemo(() => files.filter((f) => f.ignored), [files]);
  const changedTree = useMemo(() => buildTree(changed), [changed]);
  const ignoredTree = useMemo(() => buildTree(ignored), [ignored]);

  const [ignoredOpen, setIgnoredOpen] = useState(false);
  useEffect(() => {
    if (!taskId) return;
    try {
      setIgnoredOpen(localStorage.getItem(ignoredGroupKey(taskId)) === 'true');
    } catch {
      // localStorage unavailable (SSR, privacy mode, etc.) — keep default closed.
    }
  }, [taskId]);

  const toggleIgnored = () => {
    setIgnoredOpen((prev) => {
      const next = !prev;
      if (taskId) {
        try {
          localStorage.setItem(ignoredGroupKey(taskId), String(next));
        } catch {
          // ignore
        }
      }
      return next;
    });
  };

  if (files.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">No changes on this branch yet.</div>;
  }

  return (
    <div className="overflow-y-auto">
      {changed.length > 0 ? (
        <TreeRow
          node={changedTree}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          reviewed={reviewed}
          onToggleReview={onToggleReview}
        />
      ) : null}
      {ignored.length > 0 ? (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={toggleIgnored}
            aria-expanded={ignoredOpen}
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent"
          >
            <span aria-hidden className="inline-block w-3 font-mono">
              {ignoredOpen ? '▾' : '▸'}
            </span>
            <span>Ignored files ({ignored.length})</span>
            {ignoredTruncated ? (
              <span className="ml-1 normal-case text-muted-foreground/70">(+more hidden)</span>
            ) : null}
          </button>
          {ignoredOpen ? (
            <TreeRow
              node={ignoredTree}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              reviewed={reviewed}
              onToggleReview={onToggleReview}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
