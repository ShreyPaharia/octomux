import { memo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import type { StatusTab } from '@/lib/use-task-filters';
import { repoName } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { cn } from '@/lib/utils';

interface TaskFilterBarProps {
  activeStatus: StatusTab;
  counts: { all: number; running: number; needs_you: number; closed: number };
  onStatusChange: (status: StatusTab) => void;
  repos: string[];
  activeRepo: string;
  onRepoChange: (repo: string) => void;
}

interface ChipDef {
  key: StatusTab;
  label: string;
  glyphStatus: string | null;
}

const STATUS_CHIPS: ReadonlyArray<ChipDef> = [
  { key: 'all', label: 'All', glyphStatus: null },
  { key: 'running', label: 'Running', glyphStatus: 'running' },
  { key: 'needs_you', label: 'Needs You', glyphStatus: 'awaiting' },
  { key: 'closed', label: 'Closed', glyphStatus: 'closed' },
];

function FilterChip({
  chip,
  count,
  active,
  onClick,
}: {
  chip: ChipDef;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`filter-chip-${chip.key}`}
      data-active={active ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium tracking-wider uppercase transition-colors',
        active ? 'text-foreground' : 'text-[#8a8a8a] hover:text-foreground',
      )}
      style={
        active
          ? {
              backgroundColor: 'rgba(255, 255, 255, 0.14)',
              boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
            }
          : undefined
      }
    >
      {chip.glyphStatus && <StatusGlyph status={chip.glyphStatus} size={10} />}
      <span>{chip.label}</span>
      <span className={cn('tabular-nums', active ? 'text-foreground' : 'text-[#6a6a6a]')}>
        ({count})
      </span>
    </button>
  );
}

function RepoFilterDropdown({
  repos,
  activeRepo,
  onRepoChange,
}: {
  repos: string[];
  activeRepo: string;
  onRepoChange: (repo: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-[#8a8a8a] transition-colors hover:text-foreground"
          >
            {activeRepo ? (
              <Badge variant="outline" className="text-xs font-normal">
                {repoName(activeRepo)}
              </Badge>
            ) : (
              <span>all repos</span>
            )}
            <ChevronDownIcon size={12} className="text-[#8a8a8a]" />
          </button>
        }
      />
      <PopoverContent align="end" side="bottom" sideOffset={4} className="w-[200px] p-0">
        <div className="flex flex-col">
          <button
            type="button"
            className={`px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${!activeRepo ? 'bg-muted font-medium' : ''}`}
            onClick={() => {
              onRepoChange('');
              setOpen(false);
            }}
          >
            All projects
          </button>
          {repos.map((repo) => (
            <button
              key={repo}
              type="button"
              className={`flex items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${repo === activeRepo ? 'bg-muted font-medium' : ''}`}
              onClick={() => {
                onRepoChange(repo);
                setOpen(false);
              }}
            >
              <Badge variant="outline" className="text-xs font-normal">
                {repoName(repo)}
              </Badge>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const TaskFilterBar = memo(function TaskFilterBar({
  activeStatus,
  counts,
  onStatusChange,
  repos,
  activeRepo,
  onRepoChange,
}: TaskFilterBarProps) {
  return (
    <GlassPanel
      level={1}
      specular
      data-testid="task-filter-bar"
      className="my-3 flex items-center justify-between px-2 py-1.5"
    >
      <div className="flex items-center gap-1">
        {STATUS_CHIPS.map((chip) => (
          <FilterChip
            key={chip.key}
            chip={chip}
            count={counts[chip.key]}
            active={activeStatus === chip.key}
            onClick={() => onStatusChange(chip.key)}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        {repos.length > 1 && (
          <RepoFilterDropdown repos={repos} activeRepo={activeRepo} onRepoChange={onRepoChange} />
        )}
      </div>
    </GlassPanel>
  );
});
