import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { RepoPickerField } from './fields/RepoPickerField';
import { BranchPickerField } from './fields/BranchPickerField';
import type { RepoValidation } from './fields/RepoPickerField';

interface CreateTaskDialogProps {
  onCreated?: () => void;
}

export function CreateTaskDialog({ onCreated }: CreateTaskDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [draft, setDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline validation — touched state per field
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Repo path validation state (set via RepoPickerField callback)
  const [_repoValidation, setRepoValidation] = useState<RepoValidation>('idle');

  // Branch auto-generation tracking
  const [branchIsAuto, setBranchIsAuto] = useState(true);

  const markTouched = (field: string) => setTouched((prev) => ({ ...prev, [field]: true }));

  const canSubmit = title.trim() && description.trim() && repoPath.trim() && !submitting;

  // Auto-generate branch name from title
  useEffect(() => {
    if (!branchIsAuto) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setBranch('');
      return;
    }
    const slug = trimmed
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    setBranch(slug ? `feat/${slug}` : '');
  }, [title, branchIsAuto]);

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
      setInitialPrompt('');
      setShowPrompt(false);
      setDraft(false);
      setTouched({});
      setRepoValidation('idle');
      setBranchIsAuto(true);
      setOpen(false);
      onCreated?.();
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
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
              onBlur={() => markTouched('title')}
            />
            {touched.title && !title.trim() && (
              <p className="text-xs text-destructive">Title is required</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Add negative quantity checks to the order form..."
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => markTouched('description')}
            />
            {touched.description && !description.trim() && (
              <p className="text-xs text-destructive">Description is required</p>
            )}
          </div>

          {/* Repository path */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="repo-path">Repository Path</Label>
            <RepoPickerField
              value={repoPath}
              onChange={setRepoPath}
              onValidationChange={setRepoValidation}
            />
            {touched.repoPath && !repoPath.trim() && (
              <p className="text-xs text-destructive">Repository path is required</p>
            )}
          </div>

          {/* Branch name */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="branch">Branch Name</Label>
              {branchIsAuto && branch && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  auto
                </span>
              )}
            </div>
            <Input
              id="branch"
              placeholder="feat/my-feature"
              className="font-mono text-sm"
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value);
                setBranchIsAuto(false);
              }}
            />
          </div>

          {/* Base branch */}
          <div className="flex flex-col gap-2">
            <Label>Base Branch</Label>
            <BranchPickerField
            repoPath={repoPath}
            value={baseBranch}
            onChange={setBaseBranch}
            onBranchesLoaded={(_branches, defaultBranch) => {
              setBaseBranch(defaultBranch);
            }}
            disabled={!repoPath.trim()}
          />
          </div>

          {/* Initial Prompt (optional) */}
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit h-auto px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowPrompt(!showPrompt)}
            >
              {showPrompt ? '- Hide initial prompt' : '+ Add initial prompt'}
            </Button>
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
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-background pt-3 -mb-1">
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
