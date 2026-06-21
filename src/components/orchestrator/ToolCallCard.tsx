/**
 * src/components/orchestrator/ToolCallCard.tsx
 *
 * Renders a conductor tool call as a collapsible card (SHR-161), distinct from
 * prose. Inspired by GitHub Copilot's collapsed-summary-that-expands and Claude
 * Code's ⏺/⎿ tool tree. Shows a one-line summary (tool name + key arg); expands
 * to the full structured input. A task_id in the input links into /tasks/:id.
 */

import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface ToolCallCardProps {
  toolName: string;
  input: unknown;
}

/** Pull a task_id out of the tool input when present (for the deep link). */
function taskIdOf(input: unknown): string | null {
  if (input && typeof input === 'object' && 'task_id' in input) {
    const v = (input as Record<string, unknown>).task_id;
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  return null;
}

/** A concise one-line summary of the most salient argument. */
function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const title = obj.title ?? obj.message ?? obj.status ?? obj.task_id;
  if (typeof title === 'string') return title.length > 80 ? `${title.slice(0, 77)}…` : title;
  return '';
}

export function ToolCallCard({ toolName, input }: ToolCallCardProps) {
  const taskId = taskIdOf(input);
  const summary = summarize(input);

  return (
    <details
      className={cn(
        'group mr-auto max-w-[85%] rounded-xl border border-[rgba(255,255,255,0.1)]',
        'bg-[rgba(255,255,255,0.03)] text-sm',
      )}
      data-tool-name={toolName}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-2 px-3 py-2',
          'text-[rgba(255,255,255,0.7)] [&::-webkit-details-marker]:hidden',
        )}
      >
        {/* disclosure caret */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        >
          <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="font-mono text-xs text-[#A78BFA]">{toolName}</span>
        {summary && (
          <span className="truncate text-xs text-[rgba(255,255,255,0.45)]">{summary}</span>
        )}
        {taskId && (
          <Link
            to={`/tasks/${taskId}`}
            onClick={(e) => e.stopPropagation()}
            className="ml-auto shrink-0 font-mono text-xs text-[#3B82F6] underline"
          >
            {taskId}
          </Link>
        )}
      </summary>
      <pre className="overflow-x-auto border-t border-[rgba(255,255,255,0.08)] px-3 py-2 text-[11px] leading-relaxed text-[rgba(255,255,255,0.6)]">
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}
