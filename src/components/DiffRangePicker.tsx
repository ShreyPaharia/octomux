import { useEffect, useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type DiffRange, type TaskCommit } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface DiffRangePickerProps {
  taskId: string;
  /** Current task base branch — used as the picker's seed value. */
  currentBaseBranch: string | null;
  /** Currently selected range (so the radio reflects state from URL). */
  range: DiffRange;
  /** Optional, opens the popover externally. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRangeChange: (range: DiffRange) => void;
  onBaseChange: (newBranch: string) => void | Promise<void>;
  /** Trigger element. Defaults to a small "Change base…" button. */
  children?: React.ReactNode;
}

type RadioKind = 'base' | 'working' | 'commit' | 'range';

function rangeKindOf(range: DiffRange): RadioKind {
  return range.kind;
}

export function DiffRangePicker({
  taskId,
  currentBaseBranch,
  range,
  open,
  onOpenChange,
  onRangeChange,
  onBaseChange,
  children,
}: DiffRangePickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (open === undefined) setInternalOpen(next);
  };

  const [branches, setBranches] = useState<string[]>([]);
  const [branchQuery, setBranchQuery] = useState('');
  const [branchValue, setBranchValue] = useState<string>(currentBaseBranch ?? '');
  const [savingBase, setSavingBase] = useState(false);
  const [baseError, setBaseError] = useState<string | null>(null);

  const [commits, setCommits] = useState<TaskCommit[]>([]);
  const [commitsTruncated, setCommitsTruncated] = useState(false);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitQuery, setCommitQuery] = useState('');
  const [rangeFrom, setRangeFrom] = useState<string | null>(null);

  // The radio is local: clicking "Single commit" or "Range" expands the commit
  // list without emitting yet — the actual range only emits once the user picks
  // a commit. base/working emit immediately. We seed it from the active range.
  const [radio, setRadioState] = useState<RadioKind>(rangeKindOf(range));
  useEffect(() => {
    setRadioState(rangeKindOf(range));
  }, [range]);

  // Load branches once when popover opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api
      .listTaskBranches(taskId)
      .then((res) => {
        if (cancelled) return;
        setBranches(res.branches);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen, taskId]);

  // Load commits when picker opens AND a commit-relevant kind is selected.
  useEffect(() => {
    if (!isOpen) return;
    if (radio !== 'commit' && radio !== 'range') return;
    let cancelled = false;
    setCommitsLoading(true);
    api
      .listTaskCommits(taskId, { limit: 200 })
      .then((res) => {
        if (cancelled) return;
        setCommits(res.commits);
        setCommitsTruncated(res.truncated);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCommitsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, radio, taskId]);

  useEffect(() => {
    setBranchValue(currentBaseBranch ?? '');
  }, [currentBaseBranch]);

  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, branchQuery]);

  const filteredCommits = useMemo(() => {
    const q = commitQuery.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.short_sha.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q),
    );
  }, [commits, commitQuery]);

  const onSaveBase = async () => {
    if (!branchValue.trim() || branchValue === currentBaseBranch) return;
    setSavingBase(true);
    setBaseError(null);
    try {
      await onBaseChange(branchValue.trim());
      // Reset range to base after a successful base change.
      onRangeChange({ kind: 'base' });
      setOpen(false);
    } catch (err) {
      setBaseError((err as Error).message || 'Failed to update base');
    } finally {
      setSavingBase(false);
    }
  };

  const setRadio = (next: RadioKind) => {
    setRadioState(next);
    if (next === 'base') onRangeChange({ kind: 'base' });
    else if (next === 'working') onRangeChange({ kind: 'working' });
    // commit/range don't auto-emit; user must pick a commit/range below.
  };

  const pickCommit = (sha: string) => {
    onRangeChange({ kind: 'commit', sha });
    setOpen(false);
  };

  const pickRange = (toSha: string) => {
    if (!rangeFrom) {
      setRangeFrom(toSha);
      return;
    }
    onRangeChange({ kind: 'range', from: rangeFrom, to: toSha });
    setRangeFrom(null);
    setOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger
        className="rounded-md border border-glass-edge bg-glass-l1 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-glass-l2/50 hover:text-foreground"
        data-testid="diff-range-picker-trigger"
      >
        {children ?? 'Change base…'}
      </PopoverTrigger>
      <PopoverContent className="w-[360px]" align="start">
        <div className="flex flex-col gap-3">
          <section className="flex flex-col gap-1.5">
            <div className="text-[11px] font-medium text-muted-soft">Base branch</div>
            <Input
              placeholder="Search branches"
              value={branchQuery}
              onChange={(e) => setBranchQuery(e.target.value)}
              className="h-7 text-xs"
              data-testid="base-branch-search"
            />
            <div
              className="max-h-[140px] overflow-y-auto border border-glass-edge"
              role="listbox"
              aria-label="Available branches"
            >
              {filteredBranches.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-muted-foreground">No branches</div>
              ) : (
                filteredBranches.map((b) => (
                  <button
                    type="button"
                    key={b}
                    role="option"
                    aria-selected={b === branchValue}
                    onClick={() => setBranchValue(b)}
                    className={cn(
                      'block w-full px-2 py-1 text-left font-mono text-[11px] hover:bg-glass-l2',
                      b === branchValue && 'bg-glass-l2 text-foreground',
                    )}
                  >
                    {b}
                  </button>
                ))
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-muted-foreground truncate">
                Selected: {branchValue || '—'}
              </span>
              <Button
                size="xs"
                onClick={onSaveBase}
                disabled={savingBase || !branchValue.trim() || branchValue === currentBaseBranch}
                data-testid="diff-range-picker-save-base"
              >
                {savingBase ? 'Saving…' : 'Save base'}
              </Button>
            </div>
            {baseError ? <div className="text-[11px] text-destructive">{baseError}</div> : null}
          </section>

          <section className="flex flex-col gap-1.5">
            <div className="text-[11px] font-medium text-muted-soft">Range</div>
            <div className="grid grid-cols-2 gap-1 text-[11px]">
              {(
                [
                  { key: 'base', label: 'Full diff' },
                  { key: 'working', label: 'Working tree' },
                  { key: 'commit', label: 'Single commit' },
                  { key: 'range', label: 'Range from…' },
                ] as Array<{ key: RadioKind; label: string }>
              ).map((opt) => (
                <button
                  type="button"
                  key={opt.key}
                  role="radio"
                  aria-checked={radio === opt.key}
                  onClick={() => setRadio(opt.key)}
                  data-testid={`diff-range-radio-${opt.key}`}
                  className={cn(
                    'border border-glass-edge px-2 py-1 text-left',
                    radio === opt.key
                      ? 'bg-glass-l2 text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {(radio === 'commit' || radio === 'range') && (
              <div className="flex flex-col gap-1">
                {radio === 'range' && (
                  <div className="text-[11px] text-muted-foreground">
                    {rangeFrom
                      ? `From ${rangeFrom.slice(0, 7)} — pick the "to" commit below.`
                      : 'Pick the "from" commit below, then the "to" commit.'}
                  </div>
                )}
                <Input
                  placeholder="Search commits"
                  value={commitQuery}
                  onChange={(e) => setCommitQuery(e.target.value)}
                  className="h-7 text-xs"
                  data-testid="commit-search"
                />
                <div
                  className="max-h-[200px] overflow-y-auto border border-glass-edge"
                  role="listbox"
                  aria-label="Commits"
                >
                  {commitsLoading ? (
                    <div className="px-2 py-1 text-[11px] text-muted-foreground">Loading…</div>
                  ) : filteredCommits.length === 0 ? (
                    <div className="px-2 py-1 text-[11px] text-muted-foreground">No commits</div>
                  ) : (
                    filteredCommits.map((c) => (
                      <button
                        type="button"
                        key={c.sha}
                        role="option"
                        aria-selected={false}
                        onClick={() => (radio === 'commit' ? pickCommit(c.sha) : pickRange(c.sha))}
                        className="block w-full border-b border-glass-edge/50 px-2 py-1 text-left text-[11px] last:border-b-0 hover:bg-glass-l2"
                        data-testid={`commit-row-${c.short_sha}`}
                      >
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {c.short_sha}
                        </span>{' '}
                        <span className="truncate">{c.subject}</span>
                        <div className="text-[10px] text-muted-foreground">{c.author}</div>
                      </button>
                    ))
                  )}
                </div>
                {commitsTruncated ? (
                  <div className="text-[10px] text-muted-foreground">
                    Showing the most recent 200 commits.
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}
