import { useState, useEffect, useCallback } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { BrowseResult, RecentRepo } from '@/lib/api';

export type RepoValidation = 'idle' | 'loading' | 'valid' | 'invalid';

interface RepoPickerFieldProps {
  value: string;
  onChange: (value: string) => void;
  onValidationChange?: (state: RepoValidation) => void;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr + 'Z').getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RepoPickerField({ value, onChange, onValidationChange }: RepoPickerFieldProps) {
  // Recent repos
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>([]);

  // Folder browser
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  // Repo path validation state
  const [repoValidation, setRepoValidation] = useState<RepoValidation>('idle');

  // Fetch recent repos on mount
  useEffect(() => {
    api
      .recentRepos()
      .then(setRecentRepos)
      .catch(() => setRecentRepos([]));
  }, []);

  // Validate repo when value changes (debounced 500ms)
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setRepoValidation('idle');
      onValidationChange?.('idle');
      return;
    }

    let cancelled = false;
    setRepoValidation('loading');
    onValidationChange?.('loading');
    const timer = setTimeout(async () => {
      try {
        await Promise.all([api.listBranches(trimmed), api.getDefaultBranch(trimmed)]);
        if (!cancelled) {
          setRepoValidation('valid');
          onValidationChange?.('valid');
        }
      } catch {
        if (!cancelled) {
          setRepoValidation('invalid');
          onValidationChange?.('invalid');
        }
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, onValidationChange]);

  const browseTo = useCallback(async (dirPath?: string) => {
    setBrowseLoading(true);
    try {
      const data = await api.browse(dirPath);
      setBrowseData(data);
    } catch {
      // If browse fails, keep current data
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  // Load initial browse data when popover opens
  useEffect(() => {
    if (browseOpen && !browseData) {
      browseTo();
    }
  }, [browseOpen, browseData, browseTo]);

  function selectPath(selectedPath: string) {
    onChange(selectedPath);
    setBrowseOpen(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id="repo-path"
            placeholder="/Users/you/projects/my-repo"
            className="font-mono text-sm pr-8"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {/* Repo validation indicator */}
          {value.trim() && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2">
              {repoValidation === 'loading' && (
                <svg
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-label="Validating repo"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              )}
              {repoValidation === 'valid' && (
                <svg
                  className="h-4 w-4 text-emerald-500"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-label="Valid git repo"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
              {repoValidation === 'invalid' && (
                <svg
                  className="h-4 w-4 text-destructive"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-label="Not a git repository"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              )}
            </span>
          )}
        </div>
        <Popover open={browseOpen} onOpenChange={setBrowseOpen}>
          <PopoverTrigger
            render={
              <Button type="button" variant="outline" className="shrink-0">
                Browse
              </Button>
            }
          />
          <PopoverContent align="end" side="bottom" sideOffset={4} className="w-[420px] p-0">
            <FolderBrowser
              data={browseData}
              loading={browseLoading}
              onNavigate={browseTo}
              onSelect={selectPath}
            />
          </PopoverContent>
        </Popover>
      </div>
      {/* Repo validation message */}
      {value.trim() && repoValidation === 'valid' && (
        <p className="text-xs text-emerald-500">Valid git repo</p>
      )}
      {value.trim() && repoValidation === 'invalid' && (
        <p className="text-xs text-destructive">Not a git repository</p>
      )}

      {/* Recent repos */}
      {!value.trim() && recentRepos.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground font-medium">Recent</span>
          <div className="rounded-md border border-border overflow-hidden">
            {recentRepos.slice(0, 5).map((repo) => (
              <button
                key={repo.repo_path}
                type="button"
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
                onClick={() => onChange(repo.repo_path)}
              >
                <span className="font-mono text-xs truncate mr-3">{repo.repo_path}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {timeAgo(repo.last_used)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FolderBrowser({
  data,
  loading,
  onNavigate,
  onSelect,
}: {
  data: BrowseResult | null;
  loading: boolean;
  onNavigate: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  if (!data && loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex flex-col">
      {/* Header: back + current path */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          disabled={!data.parent}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          onClick={() => data.parent && onNavigate(data.parent)}
        >
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
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span className="font-mono text-xs text-muted-foreground truncate direction-rtl text-left">
          {data.current}
        </span>
      </div>

      {/* Directory list */}
      <div className="max-h-[280px] overflow-y-auto">
        {data.entries.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No subdirectories
          </div>
        )}
        {data.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
            onClick={() => onNavigate(entry.path)}
            onDoubleClick={() => entry.isGit && onSelect(entry.path)}
          >
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
              className={entry.isGit ? 'text-emerald-500' : 'text-muted-foreground'}
            >
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
            <span className="font-mono text-xs truncate">
              {entry.name}
              <span className="text-muted-foreground">/</span>
            </span>
            {entry.isGit && (
              <span className="ml-auto shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                git
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Footer: Select button */}
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground truncate mr-2">
          {data.current}
        </span>
        <Button
          type="button"
          size="sm"
          className="shrink-0 h-7 text-xs"
          onClick={() => onSelect(data.current)}
        >
          Select
        </Button>
      </div>
    </div>
  );
}
