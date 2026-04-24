import { useEffect, useMemo, useState } from 'react';
import { api, type DiffSummaryResponse } from '@/lib/api';
import { PullRequestIcon } from '@/components/icons';
import { showToast } from '@/components/CustomToast';
import type { Task } from '../../server/types';

interface Props {
  open: boolean;
  task: Task | null;
  onClose: () => void;
  onShipped?: () => void;
}

const SHEET_STYLE: React.CSSProperties = {
  boxShadow: '0 32px 80px -16px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.22)',
};

const BACKDROP_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(0,0,0,0.44)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
};

function deriveTitle(task: Task): string {
  return task.title || 'Update from agent';
}

function deriveBody(task: Task, diff: DiffSummaryResponse | null): string {
  const changes = diff?.files ?? [];
  const changesList =
    changes.length > 0
      ? changes
          .slice(0, 20)
          .map((f) => `- \`${f.path}\` (${f.status} +${f.additions} −${f.deletions})`)
          .join('\n')
      : '- (no file changes detected)';
  return (
    `## Summary\n${task.description?.trim() || task.title}\n\n` +
    `## Changes\n${changesList}\n\n` +
    `## Test plan\n- [ ] Manual smoke test\n- [ ] Unit tests pass\n- [ ] Lint + typecheck clean\n`
  );
}

export function PrSheet({ open, task, onClose, onShipped }: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [diff, setDiff] = useState<DiffSummaryResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !task) return;
    setTitle(deriveTitle(task));
    setDiff(null);
    let cancelled = false;
    api
      .getTaskDiffSummary(task.id)
      .then((d) => {
        if (!cancelled) {
          setDiff(d);
          setBody(deriveBody(task, d));
        }
      })
      .catch(() => {
        if (!cancelled) setBody(deriveBody(task, null));
      });
    return () => {
      cancelled = true;
    };
  }, [open, task]);

  const stats = useMemo(() => {
    const files = diff?.files ?? [];
    const adds = files.reduce((s, f) => s + f.additions, 0);
    const dels = files.reduce((s, f) => s + f.deletions, 0);
    return { files: files.length, adds, dels };
  }, [diff]);

  const handleSubmit = async (draft: boolean) => {
    if (!task || !title.trim() || submitting) return;
    setSubmitting(true);
    showToast('info', 'SHIPPING', 'Creating PR…');
    try {
      const result = await api.createPr(task.id, { title: title.trim(), body, draft });
      if (result.url) {
        showToast('success', 'PR OPENED', `PR #${result.number ?? ''} created`);
      } else {
        showToast('success', 'SHIPPED', 'PR draft prepared');
      }
      onShipped?.();
      onClose();
    } catch (err) {
      console.warn('createPr failed (endpoint may be stubbed):', { taskId: task.id, draft });
      showToast('error', 'SHIP FAILED', err instanceof Error ? err.message : 'Could not create PR');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleSubmit(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        void handleSubmit(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, title, body, task?.id]);

  if (!open || !task) return null;

  return (
    <div
      role="presentation"
      data-testid="pr-sheet-backdrop"
      className="fixed inset-0 z-[110] flex items-start justify-center pt-[10vh]"
      style={BACKDROP_STYLE}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ship this work"
        data-testid="pr-sheet"
        className="bg-glass-l3 glass-blur-l3 flex w-full max-w-[760px] flex-col gap-0 rounded-2xl border border-glass-edge-strong"
        style={SHEET_STYLE}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 px-6 pb-3 pt-5">
          <PullRequestIcon size={18} className="text-[#22C55E]" />
          <h1 className="text-[20px] font-bold leading-none tracking-tight text-white">
            Ship this work
          </h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="bg-glass-l1 glass-blur-l1 rounded border border-glass-edge px-2 py-0.5 font-mono text-[11px] text-[#8a8a8a] hover:text-white"
            aria-label="Close"
          >
            esc
          </button>
        </header>

        <div className="flex items-center gap-3 px-6 pb-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#3B82F640] bg-[#3B82F61F] px-2 py-0.5 font-mono text-[10px] font-medium text-[#3B82F6]">
            main ← {task.branch || 'agents/…'}
          </span>
          <span className="font-mono text-[10px] text-[#B5B5BD]">
            {stats.files} files · +{stats.adds} −{stats.dels}
          </span>
        </div>

        <div className="flex flex-col gap-4 px-6 pb-0">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="pr-title"
              className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#8a8a8a]"
            >
              PR TITLE
            </label>
            <input
              id="pr-title"
              type="text"
              data-testid="pr-sheet-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="focus-ring rounded-md border border-glass-edge bg-[#0B0C0F] px-3.5 py-2.5 text-[14px] font-medium text-white outline-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="pr-body"
              className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#8a8a8a]"
            >
              PR BODY
            </label>
            <textarea
              id="pr-body"
              data-testid="pr-sheet-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="focus-ring min-h-[260px] resize-y rounded-md border border-glass-edge bg-[#0B0C0F] px-3.5 py-3 font-mono text-[12px] leading-relaxed text-[#B5B5BD] outline-none"
            />
          </div>
        </div>

        <footer className="mt-4 flex items-center gap-3 border-t border-glass-edge bg-[#FFFFFF05] px-6 py-3.5">
          <span className="font-mono text-[11px] text-[#8a8a8a]">
            ⌘↵ Ship · ⌘D Draft PR · ⌘K Close
          </span>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="pr-sheet-draft"
            disabled={submitting || !title.trim()}
            onClick={() => void handleSubmit(true)}
            className="bg-glass-l1 glass-blur-l1 rounded-md border border-glass-edge px-3.5 py-1.5 text-[12px] font-medium text-[#D0D0D0] hover:bg-[#FFFFFF14] disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            type="button"
            data-testid="pr-sheet-submit"
            disabled={submitting || !title.trim()}
            onClick={() => void handleSubmit(false)}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#22C55E] px-4 py-1.5 text-[13px] font-bold text-[#0A0A0B] shadow-[0_6px_20px_-4px_rgba(34,197,94,0.6),inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-[#4ADE80] disabled:opacity-50"
          >
            <PullRequestIcon size={13} />
            Create PR
          </button>
        </footer>
      </div>
    </div>
  );
}
