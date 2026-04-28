import { Button } from './ui/button.js';
import type { QueuedComment } from '../hooks/useReviewQueue.js';

export interface CommentQueueDrawerProps {
  comments: QueuedComment[];
  onRemove: (id: string) => void;
  onJumpTo: (filePath: string, line: number) => void;
  onSend: () => void;
}

export function CommentQueueDrawer({
  comments,
  onRemove,
  onJumpTo,
  onSend,
}: CommentQueueDrawerProps) {
  return (
    <aside className="w-80 border-l border-glass-border flex flex-col">
      <header className="px-3 py-2 text-sm font-medium border-b border-glass-border">
        Queued review ({comments.length})
      </header>
      <ul className="flex-1 overflow-auto">
        {comments.map((c) => (
          <li key={c.id} className="p-3 border-b border-glass-border/50 flex gap-2 items-start">
            <button
              type="button"
              onClick={() => onJumpTo(c.filePath, c.line)}
              className="flex-1 text-left text-xs"
            >
              <div className="font-mono text-muted-foreground">
                {c.filePath}:{c.line}
              </div>
              {c.lineText && <div className="font-mono opacity-70">{c.lineText}</div>}
              <div className="mt-1">{c.body}</div>
            </button>
            <button
              type="button"
              onClick={() => onRemove(c.id)}
              aria-label="Remove comment"
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <footer className="p-2 border-t border-glass-border">
        <Button className="w-full" onClick={onSend} disabled={comments.length === 0}>
          Send {comments.length} comment{comments.length === 1 ? '' : 's'} to agent
        </Button>
      </footer>
    </aside>
  );
}
