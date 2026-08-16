import { useState, useEffect, useCallback } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { reviewApi, type InlineCommentDTO } from '@/lib/api/reviewApi';
import { RejectDialog } from './RejectDialog';

interface InlineCommentCardProps {
  comment: InlineCommentDTO;
  taskId: string;
  onUpdated: () => void;
  onError?: (message: string) => void;
  /** Register imperative accept/reject/edit handlers for keyboard shortcuts. */
  registerActions?: (actions: { accept: () => void; reject: () => void; edit: () => void }) => void;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'text-red-400 border-red-800',
  issue: 'text-orange-400 border-orange-800',
  suggestion: 'text-blue-400 border-blue-800',
  nit: 'text-muted-foreground border-glass-edge',
};

function SeverityBadge({ severity }: { severity: InlineCommentDTO['severity'] }) {
  if (!severity) return null;
  const cls = SEVERITY_STYLES[severity] ?? 'text-muted-foreground border-glass-edge';
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {severity}
    </span>
  );
}

export function InlineCommentCard({
  comment: initialComment,
  taskId,
  onUpdated,
  onError,
  registerActions,
}: InlineCommentCardProps) {
  const [comment, setComment] = useState(initialComment);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [editExisting, setEditExisting] = useState(comment.existing_code ?? '');
  const [editSuggested, setEditSuggested] = useState(comment.suggested_code ?? '');
  const [saving, setSaving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  useEffect(() => {
    setComment(initialComment);
    setEditBody(initialComment.body);
    setEditExisting(initialComment.existing_code ?? '');
    setEditSuggested(initialComment.suggested_code ?? '');
    setEditing(false);
  }, [initialComment]);

  const startEditing = useCallback(() => {
    setEditBody(comment.body);
    setEditExisting(comment.existing_code ?? '');
    setEditSuggested(comment.suggested_code ?? '');
    setEditing(true);
  }, [comment.body, comment.existing_code, comment.suggested_code]);

  useEffect(() => {
    if (!registerActions) return;
    registerActions({
      accept: () => {
        void handleAccept();
      },
      reject: () => setRejectOpen(true),
      edit: startEditing,
    });
  });

  async function patch(data: Parameters<typeof reviewApi.patchComment>[2]) {
    setSaving(true);
    try {
      const updated = await reviewApi.patchComment(taskId, comment.id, data);
      setComment(updated);
      onUpdated();
    } catch (err) {
      onError?.((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAccept() {
    await patch({ status: 'accepted' });
  }

  async function handleSaveEdit() {
    const data: Parameters<typeof reviewApi.patchComment>[2] = { body: editBody };
    if (comment.kind === 'suggestion') {
      data.existing_code = editExisting;
      data.suggested_code = editSuggested;
    }
    await patch(data);
    setEditing(false);
  }

  // Stale: yellow border + warning
  const isStale = comment.status === 'stale';
  // Auto-resolved: dimmed
  const isAutoResolved = !!comment.auto_resolved_at;
  // Re-flag
  const isReFlag = !!comment.re_flag_of;
  // Published: cannot edit
  const isPublished = comment.status === 'published';

  const cardBorderClass = isStale
    ? 'border-yellow-600'
    : isAutoResolved
      ? 'border-glass-edge opacity-60'
      : 'border-glass-edge';

  return (
    <>
      <div
        id={`comment-${comment.id}`}
        className={`rounded-xl border bg-glass-l1 p-4 space-y-2 ${cardBorderClass}`}
      >
        {/* Header row */}
        <div className="flex items-center gap-2 flex-wrap">
          <code className="text-xs text-blue-300">
            {comment.file_path}:{comment.line}
          </code>
          <SeverityBadge severity={comment.severity} />
          {comment.bucket && (
            <Badge variant={comment.bucket === 'actionable' ? 'default' : 'secondary'}>
              {comment.bucket}
            </Badge>
          )}
          {comment.kind === 'suggestion' && <Badge variant="outline">🔧 patch</Badge>}
          {isReFlag && (
            <a
              href={`#comment-${comment.re_flag_of}`}
              className="text-xs text-muted-foreground hover:underline"
            >
              ↻ re-flag of #{comment.re_flag_of?.slice(0, 6)}
            </a>
          )}
          {isStale && <Badge variant="destructive">stale — line moved</Badge>}
          {isAutoResolved && (
            <span
              title={comment.auto_resolved_reason ?? undefined}
              className="text-xs text-green-400 cursor-help"
            >
              ✓ resolved
            </span>
          )}
          {comment.status !== 'draft' && !isAutoResolved && (
            <Badge variant={comment.status === 'accepted' ? 'default' : 'secondary'}>
              {comment.status}
            </Badge>
          )}
        </div>

        {/* Body */}
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={3}
              placeholder="Comment body"
            />
            {comment.kind === 'suggestion' && (
              <>
                <Textarea
                  value={editExisting}
                  onChange={(e) => setEditExisting(e.target.value)}
                  rows={2}
                  placeholder="Existing code (to replace)"
                  className="font-mono text-xs"
                />
                <Textarea
                  value={editSuggested}
                  onChange={(e) => setEditSuggested(e.target.value)}
                  rows={2}
                  placeholder="Suggested code"
                  className="font-mono text-xs"
                />
              </>
            )}
            <div className="flex gap-2">
              <Button size="xs" onClick={handleSaveEdit} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm">{comment.body}</p>
            {/* Suggestion diff preview */}
            {comment.kind === 'suggestion' &&
              (comment.existing_code !== null || comment.suggested_code !== null) && (
                <div className="rounded-md border border-glass-edge overflow-hidden font-mono text-xs">
                  {comment.existing_code !== null && (
                    <div className="bg-red-950/30 px-3 py-1 text-red-300">
                      - {comment.existing_code}
                    </div>
                  )}
                  {comment.suggested_code !== null && (
                    <div className="bg-green-950/30 px-3 py-1 text-green-300">
                      + {comment.suggested_code}
                    </div>
                  )}
                </div>
              )}
          </>
        )}

        {/* Actions */}
        {!editing && !isPublished && !isAutoResolved && (
          <div className="flex gap-2 pt-1">
            {comment.status !== 'accepted' && (
              <Button size="xs" onClick={handleAccept} disabled={saving}>
                Accept
              </Button>
            )}
            {comment.status !== 'rejected' && (
              <Button
                variant="destructive"
                size="xs"
                onClick={() => setRejectOpen(true)}
                disabled={saving}
              >
                Reject
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={startEditing}>
              Edit
            </Button>
          </div>
        )}
      </div>

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onReject={async (why) => {
          await patch({ status: 'rejected', ...(why ? { rejection_why: why } : {}) });
          setRejectOpen(false);
        }}
      />
    </>
  );
}
