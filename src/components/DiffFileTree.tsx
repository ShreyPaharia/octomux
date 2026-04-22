import { useMemo } from 'react';
import type { DiffFileEntry } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  files: DiffFileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
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
}: {
  node: Node;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.isFile && node.file) {
    const f = node.file;
    const active = selected === f.path;
    return (
      <button
        type="button"
        onClick={() => onSelect(f.path)}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs hover:bg-accent',
          active && 'bg-accent',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
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
          className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
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
        />
      ))}
    </>
  );
}

export function DiffFileTree({ files, selected, onSelect }: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  if (files.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">No changes on this branch yet.</div>;
  }
  return (
    <div className="overflow-y-auto">
      <TreeRow node={tree} depth={0} selected={selected} onSelect={onSelect} />
    </div>
  );
}
