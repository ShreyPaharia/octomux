import { useState, useEffect, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';

interface BranchPickerFieldProps {
  repoPath: string;
  value: string;
  onChange: (value: string) => void;
  onBranchesLoaded?: (branches: string[], defaultBranch: string) => void;
  disabled?: boolean;
}

export function BranchPickerField({
  repoPath,
  value,
  onChange,
  onBranchesLoaded,
  disabled,
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
          api.listBranches(trimmed),
          api.getDefaultBranch(trimmed),
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
              className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className={value ? 'font-mono text-xs' : 'text-muted-foreground'}>
                {value || 'Select base branch...'}
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          }
        />
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={4}
          className="w-[--trigger-width] p-0"
        >
          <div className="flex flex-col">
            <div className="border-b border-border px-3 py-2">
              <input
                type="text"
                placeholder="Search branches..."
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                value={branchSearch}
                onChange={(e) => setBranchSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div className="max-h-[200px] overflow-y-auto">
              {filteredBranches.length === 0 && (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                  {branches.length === 0 ? 'Select a repository first' : 'No matching branches'}
                </div>
              )}
              {filteredBranches.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={`flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors ${b === value ? 'bg-muted font-medium' : ''}`}
                  onClick={() => {
                    onChange(b);
                    setBranchSearch('');
                    setBranchDropdownOpen(false);
                  }}
                >
                  <span className="font-mono text-xs truncate">{b}</span>
                </button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
