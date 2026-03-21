import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import type { Task } from '../../server/types';
import type { BrowseResult } from '@/lib/api';

interface DraftEditFormProps {
  task: Task;
  onSaved: () => void;
  onStart: () => void;
}

export function DraftEditForm({ task, onSaved, onStart }: DraftEditFormProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [repoPath, setRepoPath] = useState(task.repo_path);
  const [branch, setBranch] = useState(task.branch ?? '');
  const [baseBranch, setBaseBranch] = useState(task.base_branch ?? '');
  const [initialPrompt, setInitialPrompt] = useState(task.initial_prompt ?? '');
  const [showPrompt, setShowPrompt] = useState(!!task.initial_prompt);

  const [branches, setBranches] = useState<string[]>([]);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);

  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Ref to read baseBranch inside useEffect without adding it as a dep.
  // We only want to auto-set baseBranch when it's empty, not re-fetch on every change.
  const baseBranchRef = useRef(baseBranch);
  baseBranchRef.current = baseBranch;

  // Fetch branches + default branch when repo path changes
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
          // Only auto-set base branch if it's currently empty
          if (!baseBranchRef.current) {
            setBaseBranch(defaultBranch.branch);
          }
        }
      } catch {
        if (!cancelled) {
          setBranches([]);
        }
      }
    }, 300);

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
      // keep current data
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (browseOpen && !browseData) {
      browseTo();
    }
  }, [browseOpen, browseData, browseTo]);

  function selectPath(selectedPath: string) {
    setRepoPath(selectedPath);
    setBrowseOpen(false);
  }

  async function handleSave() {
    if (!title.trim() || !description.trim() || !repoPath.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateTask(task.id, {
        title: title.trim(),
        description: description.trim(),
        repo_path: repoPath.trim(),
        branch: branch.trim() || undefined,
        base_branch: baseBranch.trim() || undefined,
        initial_prompt: initialPrompt.trim() || undefined,
      });
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const canSave = title.trim() && description.trim() && repoPath.trim() && !saving;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-title">Title</Label>
          <Input
            id="edit-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-description">Description</Label>
          <Textarea
            id="edit-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Task description"
            rows={3}
          />
        </div>

        {/* Repository path with Browse */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-repo-path">Repository Path</Label>
          <div className="flex gap-2">
            <Input
              id="edit-repo-path"
              className="flex-1 font-mono text-sm"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/you/projects/my-repo"
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
        </div>

        {/* Branch name */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-branch">Branch Name</Label>
          <Input
            id="edit-branch"
            className="font-mono text-sm"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="feat/my-feature"
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
                      {branches.length === 0 ? 'Select a repository first' : 'No matching branches'}
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

        {/* Initial Prompt */}
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
              id="edit-initial-prompt"
              placeholder="Custom prompt to send to the agent on start..."
              rows={4}
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
            />
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={!canSave}
            className="font-mono text-xs font-bold uppercase tracking-wider"
          >
            {saving ? 'SAVING...' : 'SAVE'}
          </Button>
          <Button
            variant="outline"
            onClick={onStart}
            className="font-mono text-xs font-bold uppercase tracking-wider"
          >
            START
          </Button>
          {saved && <span className="font-mono text-xs text-[#22C55E]">SAVED</span>}
        </div>
      </div>
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
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <div className="flex flex-col truncate mr-2">
          <span className="font-mono text-[10px] text-muted-foreground truncate">
            {data.current}
          </span>
          <span className="text-[10px] text-muted-foreground/60">
            Double-click a git repo to select it
          </span>
        </div>
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
