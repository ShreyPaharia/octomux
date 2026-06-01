import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { RepoPickerField } from '@/components/fields/RepoPickerField';
import { BranchPickerField } from '@/components/fields/BranchPickerField';
import { HarnessPicker } from '@/components/HarnessPicker';
import { useTasksContext } from '@/lib/tasks-context';
import { api } from '@/lib/api';
import type { CreateTaskRequest } from '../../server/types';

type Mode = 'paste' | 'github';

export interface ParsedTask {
  title: string;
  prompt: string;
}

/**
 * Parse the paste-mode textarea into a list of tasks.
 *
 * Forgiving rules:
 * - Blocks are separated by one or more blank lines.
 * - If the text contains multiple blocks, each block becomes one task: the
 *   first line is the title and the remaining lines (if any) are the prompt.
 * - If there is only a single block (no blank-line separators), every
 *   non-empty line becomes its own task (title === prompt).
 */
export function parsePastePrompts(text: string): ParsedTask[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length <= 1) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ title: line.slice(0, 120), prompt: line }));
  }

  return blocks.map((block) => {
    const lines = block.split('\n');
    const title = (lines[0] ?? '').trim();
    const rest = lines.slice(1).join('\n').trim();
    return { title: title.slice(0, 120), prompt: rest || title };
  });
}

/** Parse a comma/space-separated list of issue numbers into unique positive ints. */
export function parseIssueNumbers(input: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const tok of input.split(/[\s,]+/)) {
    const n = Number.parseInt(tok.trim(), 10);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

interface GithubIssue {
  title: string;
  body: string | null;
  number: number;
  html_url: string;
}

/** Fetch a single public GitHub issue (no auth — public repos only for v1). */
async function fetchGithubIssue(repo: string, number: number): Promise<GithubIssue> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`#${number}: GitHub returned ${res.status}`);
  }
  return (await res.json()) as GithubIssue;
}

interface BulkCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface BatchResult {
  created: number;
  failed: Array<{ label: string; reason: string }>;
}

/** One unit of work: a label for error reporting + a builder that yields the payload. */
interface TaskProducer {
  label: string;
  build: () => Promise<CreateTaskRequest> | CreateTaskRequest;
}

export function BulkCreateDialog({ open, onOpenChange }: BulkCreateDialogProps) {
  const navigate = useNavigate();
  const { refresh } = useTasksContext();

  const [mode, setMode] = useState<Mode>('paste');

  // Paste mode
  const [pasteText, setPasteText] = useState('');

  // GitHub mode
  const [ghRepo, setGhRepo] = useState('');
  const [ghNumbers, setGhNumbers] = useState('');

  // Shared task settings
  const [repoPath, setRepoPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [harnessId, setHarnessId] = useState<string | null>(null);

  // Submission state
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);

  const submitting = progress !== null;

  const reset = useCallback(() => {
    setPasteText('');
    setGhRepo('');
    setGhNumbers('');
    setProgress(null);
    setResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return; // don't allow closing mid-batch
      if (!next) reset();
      onOpenChange(next);
    },
    [submitting, reset, onOpenChange],
  );

  const buildProducers = useCallback((): TaskProducer[] => {
    if (mode === 'paste') {
      return parsePastePrompts(pasteText).map((t) => ({
        label: t.title,
        build: (): CreateTaskRequest => ({ title: t.title, initial_prompt: t.prompt }),
      }));
    }
    const repo = ghRepo.trim();
    return parseIssueNumbers(ghNumbers).map((number) => ({
      label: `#${number}`,
      build: async (): Promise<CreateTaskRequest> => {
        const issue = await fetchGithubIssue(repo, number);
        const body = (issue.body ?? '').trim();
        const initial_prompt = `${body ? `${body}\n\n` : ''}Closes #${number}`;
        return { title: issue.title, initial_prompt };
      },
    }));
  }, [mode, pasteText, ghRepo, ghNumbers]);

  const producerCount =
    mode === 'paste' ? parsePastePrompts(pasteText).length : parseIssueNumbers(ghNumbers).length;

  const canSubmit =
    !submitting &&
    repoPath.trim().length > 0 &&
    producerCount > 0 &&
    (mode !== 'github' || ghRepo.trim().includes('/'));

  const handleSubmit = useCallback(async () => {
    const producers = buildProducers();
    if (producers.length === 0 || !repoPath.trim()) return;

    setResult(null);
    const failed: BatchResult['failed'] = [];
    let created = 0;

    for (let i = 0; i < producers.length; i++) {
      setProgress({ current: i + 1, total: producers.length });
      const producer = producers[i];
      try {
        const base = await producer.build();
        const payload: CreateTaskRequest = {
          ...base,
          run_mode: 'new',
          repo_path: repoPath.trim(),
          ...(baseBranch.trim() ? { base_branch: baseBranch.trim() } : {}),
          ...(harnessId ? { harness_id: harnessId } : {}),
        };
        await api.createTask(payload);
        created += 1;
      } catch (err) {
        failed.push({ label: producer.label, reason: (err as Error).message || 'unknown error' });
      }
    }

    setProgress(null);
    refresh();

    if (failed.length === 0) {
      reset();
      onOpenChange(false);
      navigate('/monitor');
      return;
    }
    // Partial failure — keep the dialog open and show the summary.
    setResult({ created, failed });
  }, [buildProducers, repoPath, baseBranch, harnessId, refresh, reset, onOpenChange, navigate]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="bulk-create-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk create tasks</DialogTitle>
          <DialogDescription>
            Spawn several tasks at once. They share the repo, base branch, and coding agent below.
          </DialogDescription>
        </DialogHeader>

        <SegmentedControl<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'paste', label: 'Paste prompts', testId: 'bulk-mode-paste' },
            { value: 'github', label: 'GitHub issues', testId: 'bulk-mode-github' },
          ]}
        />

        {mode === 'paste' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-paste">Prompts</Label>
            <Textarea
              id="bulk-paste"
              data-testid="bulk-paste-textarea"
              rows={6}
              placeholder={
                'One task per line. Or separate blocks with a blank line — the first line is the title, the rest is the prompt.'
              }
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            {producerCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {producerCount} task{producerCount === 1 ? '' : 's'} will be created
              </span>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-gh-repo">owner / repo</Label>
              <Input
                id="bulk-gh-repo"
                data-testid="bulk-gh-repo"
                placeholder="ShreyPaharia/octomux"
                className="font-mono text-sm"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-gh-numbers">Issue numbers</Label>
              <Input
                id="bulk-gh-numbers"
                data-testid="bulk-gh-numbers"
                placeholder="124, 125, 126"
                className="font-mono text-sm"
                value={ghNumbers}
                onChange={(e) => setGhNumbers(e.target.value)}
              />
              {producerCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {producerCount} issue{producerCount === 1 ? '' : 's'} → tasks (public repos only)
                </span>
              )}
            </div>
          </div>
        )}

        {/* Shared settings */}
        <div className="flex flex-col gap-3 rounded-lg border border-glass-edge bg-glass-l1/40 p-3">
          <div className="flex flex-col gap-1.5">
            <Label>Repository</Label>
            <RepoPickerField value={repoPath} onChange={setRepoPath} />
          </div>
          <div className="flex items-end gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label>Base branch</Label>
              <BranchPickerField repoPath={repoPath} value={baseBranch} onChange={setBaseBranch} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Coding agent</Label>
              <HarnessPicker value={harnessId} onChange={setHarnessId} />
            </div>
          </div>
        </div>

        {progress && (
          <div
            data-testid="bulk-progress"
            className="rounded-lg border border-glass-edge bg-glass-l1/50 px-3 py-2 text-xs text-muted-foreground"
          >
            Creating {progress.current} of {progress.total}…
          </div>
        )}

        {result && (
          <div
            role="status"
            data-testid="bulk-summary"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
          >
            <div className="font-medium">
              {result.created} created, {result.failed.length} failed
            </div>
            <ul className="mt-1 list-disc pl-4">
              {result.failed.map((f) => (
                <li key={f.label}>
                  {f.label}: {f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button
              data-testid="bulk-goto-monitor"
              onClick={() => {
                reset();
                onOpenChange(false);
                navigate('/monitor');
              }}
            >
              Go to Monitor
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button data-testid="bulk-create-submit" onClick={handleSubmit} disabled={!canSubmit}>
                {submitting
                  ? 'Creating…'
                  : `Create ${producerCount || ''} task${producerCount === 1 ? '' : 's'}`.trim()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
