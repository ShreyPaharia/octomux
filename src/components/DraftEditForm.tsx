import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { GlassPanel } from '@/components/ui/glass-panel';
import { taskApi } from '@/lib/api/taskApi';
import type { Task } from '@octomux/types';
import { RepoPickerField } from './fields/RepoPickerField';
import { BranchPickerField } from './fields/BranchPickerField';

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

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isScratch = task.run_mode === 'scratch';

  async function handleSave() {
    if (!title.trim() || !description.trim()) return;
    if (!isScratch && !repoPath.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await taskApi.updateTask(task.id, {
        title: title.trim(),
        description: description.trim(),
        repo_path: isScratch ? undefined : repoPath.trim(),
        branch: isScratch ? undefined : branch.trim() || undefined,
        base_branch: isScratch ? undefined : baseBranch.trim() || undefined,
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

  const canSave =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    (isScratch || repoPath.trim().length > 0) &&
    !saving;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <GlassPanel
        level={2}
        specular
        className="flex flex-col gap-5 rounded-2xl p-6 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]"
      >
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

        {!isScratch && (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="repo-path">Repository Path</Label>
              <RepoPickerField value={repoPath} onChange={setRepoPath} />
            </div>

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

            <div className="flex flex-col gap-2">
              <Label>Base Branch</Label>
              <BranchPickerField
                repoPath={repoPath}
                value={baseBranch}
                onChange={setBaseBranch}
                onBranchesLoaded={(_branches, defaultBranch) => {
                  // Only auto-fill when empty so we don't clobber a saved draft.
                  setBaseBranch((current) => current || defaultBranch);
                }}
                disabled={!repoPath.trim()}
              />
            </div>
          </>
        )}

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
      </GlassPanel>
    </div>
  );
}
