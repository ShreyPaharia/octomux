import { useState, useEffect, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { taskApi } from '@/lib/api/taskApi';
import { ChevronDownIcon } from '@/components/icons';

interface BranchPickerFieldProps {
  repoPath: string;
  value: string;
  onChange: (value: string) => void;
  onBranchesLoaded?: (branches: string[], defaultBranch: string) => void;
  disabled?: boolean;
  /** Override trigger button className — e.g. to blend into a chip pill. */
  triggerClassName?: string;
}

export function BranchPickerField({
  repoPath,
  value,
  onChange,
  onBranchesLoaded,
  disabled,
  triggerClassName,
}: BranchPickerFieldProps) {
  const [branches, setBranches] = useState<string[]>([]);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);

  // Fetch branches when repoPath changes (debounced 500ms)
  useEffect(() => {
    const trimmed = repoPath.trim();
    if (!trimmed) {
      setBranches([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const [branchList, defaultBranch] = await Promise.all([
          taskApi.listBranches(trimmed),
          taskApi.getDefaultBranch(trimmed),
        ]);
        if (!cancelled) {
          setBranches(branchList);
          if (onBranchesLoaded) {
            onBranchesLoaded(branchList, defaultBranch.branch);
          } else {
            onChange(defaultBranch.branch);
          }
        }
      } catch {
        if (!cancelled) {
          setBranches([]);
        }
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredBranches = useMemo(
    () => branches.filter((b) => b.toLowerCase().includes(branchSearch.toLowerCase())),
    [branches, branchSearch],
  );

  return (
    <div className="flex flex-col gap-2">
      <Popover open={branchDropdownOpen} onOpenChange={setBranchDropdownOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              disabled={disabled || branches.length === 0}
              className={
                triggerClassName ??
                'flex h-9 w-full items-center justify-between rounded-lg border border-glass-edge bg-glass-l1 px-3 py-1 text-sm transition-colors hover:bg-glass-l2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              }
            >
              <span className={value ? 'font-mono text-xs' : 'text-muted-foreground'}>
                {value || 'Select base branch...'}
              </span>
              <ChevronDownIcon className="text-muted-foreground" />
            </button>
          }
        />
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={4}
          className="w-[--trigger-width] gap-1 p-1.5"
        >
          <div className="border-b border-glass-edge px-2 pb-2">
            <input
              type="text"
              placeholder="Search branches..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              value={branchSearch}
              onChange={(e) => setBranchSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-[220px] overflow-y-auto py-1">
            {filteredBranches.length === 0 && (
              <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                {branches.length === 0 ? 'Select a repository first' : 'No matching branches'}
              </div>
            )}
            {filteredBranches.map((b) => {
              const selected = b === value;
              return (
                <button
                  key={b}
                  type="button"
                  className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                    selected
                      ? 'border border-[#3B82F666] bg-[#3B82F61F] font-medium text-foreground'
                      : 'border border-transparent hover:bg-glass-l2'
                  }`}
                  onClick={() => {
                    onChange(b);
                    setBranchSearch('');
                    setBranchDropdownOpen(false);
                  }}
                >
                  <span className="font-mono text-xs truncate">{b}</span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
