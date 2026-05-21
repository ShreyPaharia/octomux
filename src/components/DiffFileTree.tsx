import { useEffect, useMemo, useState } from 'react';
import type { DiffFileEntry } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DIFF_TREE_ACTIVE, DIFF_TREE_ROW } from '@/lib/design-tokens';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';

interface Props {
  files: DiffFileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  taskId?: string;
  ignoredTruncated?: boolean;
  reviewed?: Set<string>;
  onToggleReview?: (path: string) => void;
  onToggleReviewed?: (path: string, currentlyReviewed: boolean) => void;
}

export function ignoredGroupKey(taskId: string): string {
  return `octomux:diff-ignored-open:${taskId}`;
}

export function topGroupKey(taskId: string, group: string): string {
  return `octomux:diff-group-open:${taskId}:${group}`;
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

interface FolderCounts {
  reviewed: number;
  total: number;
}

function countFolder(node: Node): FolderCounts {
  if (node.isFile && node.file) {
    return { reviewed: node.file.reviewed ? 1 : 0, total: 1 };
  }
  let reviewed = 0;
  let total = 0;
  if (node.children) {
    for (const child of node.children.values()) {
      const sub = countFolder(child);
      reviewed += sub.reviewed;
      total += sub.total;
    }
  }
  return { reviewed, total };
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
  onToggleReviewed,
  collapsible,
  openGroups,
  onToggleGroup,
}: {
  node: Node;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  reviewed?: Set<string>;
  onToggleReview?: (path: string) => void;
  onToggleReviewed?: (path: string, currentlyReviewed: boolean) => void;
  collapsible?: boolean;
  openGroups?: Record<string, boolean>;
  onToggleGroup?: (path: string) => void;
}) {
  if (node.isFile && node.file) {
    const f = node.file;
    const active = selected === f.path;
    const isReviewed = reviewed?.has(f.path) ?? !!f.reviewed;
    const showCheckbox = Boolean(onToggleReview || onToggleReviewed);
    const handleToggle = () => {
      if (onToggleReviewed) onToggleReviewed(f.path, isReviewed);
      else if (onToggleReview) onToggleReview(f.path);
    };
    return (
      <div
        data-testid={`diff-file-row-${f.path}`}
        data-reviewed={isReviewed ? 'true' : 'false'}
        data-active={active ? 'true' : undefined}
        className={cn(DIFF_TREE_ROW, active && DIFF_TREE_ACTIVE, 'data-[reviewed=true]:opacity-60')}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {showCheckbox ? (
          <input
            type="checkbox"
            checked={isReviewed}
            aria-label={isReviewed ? `Unmark ${f.path} as reviewed` : `Mark ${f.path} as reviewed`}
            data-testid={`review-toggle-${f.path}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              handleToggle();
            }}
            className="h-3.5 w-3.5 shrink-0 cursor-pointer"
          />
        ) : null}
        {f.changed_since_review ? (
          <Popover>
            <PopoverTrigger
              aria-label="Changed since review"
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
              onClick={(e) => e.stopPropagation()}
            />
            <PopoverContent className="w-72">
              <div className="text-xs">
                You reviewed this at commit{' '}
                <code>{f.reviewed_at_commit?.slice(0, 7) ?? '(unknown)'}</code>. Changes have
                happened since.
              </div>
              <Button size="sm" variant="ghost" disabled aria-disabled="true">
                View since-last-review diff (v1.5)
              </Button>
            </PopoverContent>
          </Popover>
        ) : null}
        <button
          type="button"
          onClick={() => onSelect(f.path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className={cn('font-mono text-[10px] font-bold', statusColor[f.status])}>
            {f.status}
          </span>
          <span className={cn('truncate', isReviewed && 'text-muted-soft')}>{node.name}</span>
        </button>
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          <span className="text-green-500">+{f.additions}</span>
          <span className="text-muted-foreground"> / </span>
          <span className="text-red-500">-{f.deletions}</span>
        </span>
      </div>
    );
  }
  const children = node.children ? Array.from(node.children.values()) : [];
  children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const isGroupCollapsible = Boolean(node.name && collapsible);
  const groupOpen = isGroupCollapsible ? (openGroups?.[node.fullPath] ?? true) : true;
  const counts = node.name ? countFolder(node) : null;
  return (
    <>
      {node.name &&
        (isGroupCollapsible ? (
          <button
            type="button"
            data-testid={`diff-group-${node.fullPath}`}
            aria-expanded={groupOpen}
            onClick={() => onToggleGroup?.(node.fullPath)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-medium text-muted-foreground hover:bg-glass-l2/60"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <span aria-hidden className="inline-block w-3 font-mono">
              {groupOpen ? '▾' : '▸'}
            </span>
            <span>{node.name}</span>
            {counts && counts.total > 0 ? (
              <span className="ml-1 normal-case text-muted-foreground/70">
                ({counts.reviewed}/{counts.total})
              </span>
            ) : null}
          </button>
        ) : (
          <div
            data-testid={`diff-group-${node.fullPath}`}
            className="px-2 py-0.5 text-[11px] font-medium text-muted-soft"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {node.name}
            {counts && counts.total > 0 ? (
              <span className="ml-1 normal-case text-muted-foreground/70">
                ({counts.reviewed}/{counts.total})
              </span>
            ) : null}
          </div>
        ))}
      {groupOpen &&
        children.map((child) => (
          <TreeRow
            key={child.fullPath}
            node={child}
            depth={node.name ? depth + 1 : depth}
            selected={selected}
            onSelect={onSelect}
            reviewed={reviewed}
            onToggleReview={onToggleReview}
            onToggleReviewed={onToggleReviewed}
            collapsible={collapsible}
            openGroups={openGroups}
            onToggleGroup={onToggleGroup}
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
  onToggleReviewed,
}: Props) {
  const changed = useMemo(() => files.filter((f) => !f.ignored), [files]);
  const ignored = useMemo(() => files.filter((f) => f.ignored), [files]);
  const changedTree = useMemo(() => buildTree(changed), [changed]);
  const ignoredTree = useMemo(() => buildTree(ignored), [ignored]);

  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!taskId) return;
    try {
      setIgnoredOpen(localStorage.getItem(ignoredGroupKey(taskId)) === 'true');
    } catch {
      // localStorage unavailable (SSR, privacy mode, etc.) — keep default closed.
    }
  }, [taskId]);

  const toggleGroup = (path: string) => {
    setOpenGroups((prev) => {
      const current = prev[path] ?? true;
      const next = { ...prev, [path]: !current };
      if (taskId) {
        try {
          localStorage.setItem(topGroupKey(taskId, path), String(!current));
        } catch {
          // ignore
        }
      }
      return next;
    });
  };

  useEffect(() => {
    if (!taskId) return;
    const next: Record<string, boolean> = {};
    const walk = (node: Node) => {
      if (node.name) {
        try {
          const stored = localStorage.getItem(topGroupKey(taskId, node.fullPath));
          if (stored !== null) next[node.fullPath] = stored === 'true';
        } catch {
          // ignore
        }
      }
      if (node.children) {
        for (const c of node.children.values()) walk(c);
      }
    };
    walk(changedTree);
    setOpenGroups(next);
  }, [taskId, changedTree]);

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
    <div className="flex-1 overflow-y-auto p-1">
      {changed.length > 0 ? (
        <TreeRow
          node={changedTree}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          reviewed={reviewed}
          onToggleReview={onToggleReview}
          onToggleReviewed={onToggleReviewed}
          collapsible
          openGroups={openGroups}
          onToggleGroup={toggleGroup}
        />
      ) : null}
      {ignored.length > 0 ? (
        <div className="border-t border-glass-edge">
          <button
            type="button"
            onClick={toggleIgnored}
            aria-expanded={ignoredOpen}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-glass-l2/60"
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
              onToggleReviewed={onToggleReviewed}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
