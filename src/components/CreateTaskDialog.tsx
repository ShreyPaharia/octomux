import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import type { BrowseResult, RecentRepo } from '@/lib/api';

interface CreateTaskDialogProps {
  onCreated: () => void;
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

export function CreateTaskDialog({ onCreated }: CreateTaskDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [draft, setDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recent repos
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>([]);

  // Folder browser
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  const canSubmit = title.trim() && description.trim() && repoPath.trim() && !submitting;

  // Fetch recent repos when dialog opens
  useEffect(() => {
    if (open) {
      api
        .recentRepos()
        .then(setRecentRepos)
        .catch(() => setRecentRepos([]));
    }
  }, [open]);

  // Fetch branches + default branch when repo path changes
  useEffect(() => {
    const trimmed = repoPath.trim();
    if (!trimmed) {
      setBranches([]);
      setBaseBranch('');
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
          setBaseBranch(defaultBranch.branch);
        }
      } catch {
        if (!cancelled) {
          setBranches([]);
        }
      }
    }, 300); // debounce

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoPath]);

  const filteredBranches = branches.filter((b) =>
    b.toLowerCase().includes(branchSearch.toLowerCase()),
  );

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
    setRepoPath(selectedPath);
    setBrowseOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      await api.createTask({
        title: title.trim(),
        description: description.trim(),
        repo_path: repoPath.trim(),
        branch: branch.trim() || undefined,
        base_branch: baseBranch.trim() || undefined,
        initial_prompt: initialPrompt.trim() || undefined,
        draft: draft || undefined,
      });
      setTitle('');
      setDescription('');
      setRepoPath('');
      setBranch('');
      setBaseBranch('');
      setBranches([]);
      setBranchSearch('');
      setInitialPrompt('');
      setShowPrompt(false);
      setDraft(false);
      setOpen(false);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          data-icon="inline-start"
        >
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        New Task
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              placeholder="Fix order validation"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Add negative quantity checks to the order form..."
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Repository path with Browse button */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="repo-path">Repository Path</Label>
            <div className="flex gap-2">
              <Input
                id="repo-path"
                placeholder="/Users/you/projects/my-repo"
                className="flex-1 font-mono text-sm"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
              />
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

            {/* Recent repos */}
            {!repoPath.trim() && recentRepos.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Recent</span>
                <div className="rounded-md border border-border overflow-hidden">
                  {recentRepos.slice(0, 5).map((repo) => (
                    <button
                      key={repo.repo_path}
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
                      onClick={() => setRepoPath(repo.repo_path)}
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

          {/* Branch name */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="branch">Branch Name</Label>
            <Input
              id="branch"
              placeholder="feat/my-feature"
              className="font-mono text-sm"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>

          {/* Base branch */}
          <div className="flex flex-col gap-2">
            <Label>Base Branch</Label>
            <Popover open={branchDropdownOpen} onOpenChange={setBranchDropdownOpen}>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className={baseBranch ? 'font-mono text-xs' : 'text-muted-foreground'}>
                      {baseBranch || 'Select base branch...'}
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
                        {branches.length === 0
                          ? 'Select a repository first'
                          : 'No matching branches'}
                      </div>
                    )}
                    {filteredBranches.map((b) => (
                      <button
                        key={b}
                        type="button"
                        className={`flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors ${b === baseBranch ? 'bg-muted font-medium' : ''}`}
                        onClick={() => {
                          setBaseBranch(b);
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

          {/* Initial Prompt (optional) */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="w-fit cursor-pointer border-0 bg-transparent p-0 text-xs text-muted-foreground outline-0 ring-0 hover:text-foreground transition-colors text-left focus:outline-0 focus:ring-0 focus-visible:outline-0 focus-visible:ring-0"
              onClick={() => setShowPrompt(!showPrompt)}
            >
              {showPrompt ? '- Hide initial prompt' : '+ Add initial prompt'}
            </button>
            {showPrompt && (
              <Textarea
                id="initial-prompt"
                placeholder="Custom prompt to send to the agent on start..."
                rows={4}
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
              />
            )}
          </div>

          {/* Draft mode */}
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              className="rounded border-border"
            />
            Save as draft (start later)
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
