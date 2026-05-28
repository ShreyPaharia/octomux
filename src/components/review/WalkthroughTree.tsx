import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { api } from '../../lib/api';

interface TicketCompliance {
  ticket: string;
  status: 'compliant' | 'partially' | 'non-compliant';
}

interface WalkthroughFile {
  path: string;
  label?: string;
  summary?: string;
}

interface WalkthroughGroup {
  name: string;
  summary?: string;
  files?: WalkthroughFile[];
}

interface WalkthroughGlobal {
  type?: string;
  risk?: string;
  effort?: number;
  relevant_tests?: string;
  security_concerns?: string | null;
  ticket_compliance?: TicketCompliance[];
  summary?: string;
  key_review_points?: string[];
}

export interface Walkthrough {
  global?: WalkthroughGlobal;
  groups?: WalkthroughGroup[];
}

interface EditSection {
  kind: 'global' | 'group' | 'file';
  key: string;
  value?: unknown;
}

interface WalkthroughTreeProps {
  walkthrough: Walkthrough;
  onEditSection: (section: EditSection) => void;
  runId?: string | null;
  taskId?: string;
  onRefresh?: () => void;
}

function ScalarPill({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-glass-edge bg-glass-l1 px-2 py-0.5 text-xs text-muted-foreground ${className}`}
    >
      {children}
    </span>
  );
}

export function WalkthroughTree({ walkthrough, runId, taskId, onRefresh }: WalkthroughTreeProps) {
  const g = walkthrough.global ?? {};
  const groups = walkthrough.groups ?? [];

  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
  const [editingSection, setEditingSection] = useState<{
    kind: 'summary' | 'key_review_points';
    value: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  function toggleGroup(idx: number) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function startEdit(kind: 'summary' | 'key_review_points') {
    const value = kind === 'summary' ? (g.summary ?? '') : (g.key_review_points ?? []).join('\n');
    setEditingSection({ kind, value });
  }

  async function saveEdit() {
    if (!editingSection || !runId || !taskId) return;
    setSaving(true);
    try {
      const partial: Record<string, unknown> = {};
      if (editingSection.kind === 'summary') {
        partial['global'] = { summary: editingSection.value };
      } else {
        partial['global'] = {
          key_review_points: editingSection.value
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }
      await api.patchWalkthrough(taskId, runId, partial);
      onRefresh?.();
    } catch {
      // ignore
    } finally {
      setSaving(false);
      setEditingSection(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-glass-edge bg-glass-l1 p-4">
      {/* Scalar pill bar */}
      {(g.type || g.risk || g.effort !== undefined || g.relevant_tests) && (
        <div className="flex flex-wrap gap-2">
          {g.type && <ScalarPill>{g.type}</ScalarPill>}
          {g.risk && <ScalarPill>Risk: {g.risk}</ScalarPill>}
          {g.effort !== undefined && <ScalarPill>Effort {g.effort}/5</ScalarPill>}
          {g.relevant_tests && <ScalarPill>Tests: {g.relevant_tests}</ScalarPill>}
          {g.security_concerns && (
            <ScalarPill className="text-yellow-400">Security: {g.security_concerns}</ScalarPill>
          )}
        </div>
      )}

      {/* Ticket compliance */}
      {g.ticket_compliance && g.ticket_compliance.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {g.ticket_compliance.map((tc) => (
            <ScalarPill key={tc.ticket}>
              {tc.ticket}{' '}
              <span
                className={
                  tc.status === 'compliant'
                    ? 'text-green-400'
                    : tc.status === 'partially'
                      ? 'text-yellow-400'
                      : 'text-red-400'
                }
              >
                {tc.status}
              </span>
            </ScalarPill>
          ))}
        </div>
      )}

      {/* Summary */}
      {g.summary && (
        <div>
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-foreground">{g.summary}</p>
            {runId && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => startEdit('summary')}
                className="shrink-0 text-xs"
              >
                Edit
              </Button>
            )}
          </div>
          {editingSection?.kind === 'summary' && (
            <div className="mt-2 space-y-2">
              <Textarea
                value={editingSection.value}
                onChange={(e) => setEditingSection({ ...editingSection, value: e.target.value })}
                rows={3}
              />
              <div className="flex gap-2">
                <Button size="xs" onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setEditingSection(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Key review points */}
      {g.key_review_points && g.key_review_points.length > 0 && (
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Key points
            </p>
            {runId && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => startEdit('key_review_points')}
                className="text-xs"
              >
                Edit
              </Button>
            )}
          </div>
          {editingSection?.kind === 'key_review_points' ? (
            <div className="space-y-2">
              <Textarea
                value={editingSection.value}
                onChange={(e) => setEditingSection({ ...editingSection, value: e.target.value })}
                placeholder="One point per line"
                rows={4}
              />
              <div className="flex gap-2">
                <Button size="xs" onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setEditingSection(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <ul className="space-y-1">
              {g.key_review_points.map((pt, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-1 shrink-0 text-muted-foreground">·</span>
                  <span>{pt}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Groups */}
      {groups.length > 0 && (
        <div className="space-y-2">
          {groups.map((group, idx) => (
            <details
              key={idx}
              open={!collapsedGroups.has(idx)}
              onToggle={(e) => {
                const open = (e.target as HTMLDetailsElement).open;
                setCollapsedGroups((prev) => {
                  const next = new Set(prev);
                  if (!open) next.add(idx);
                  else next.delete(idx);
                  return next;
                });
              }}
              className="rounded-lg border border-glass-edge"
            >
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-glass-l1">
                <span>{group.name}</span>
                {group.summary && (
                  <span className="text-xs text-muted-foreground font-normal">
                    — {group.summary}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto text-xs"
                  onClick={(e) => {
                    e.preventDefault();
                    toggleGroup(idx);
                  }}
                >
                  {collapsedGroups.has(idx) ? 'Expand' : 'Collapse'}
                </Button>
              </summary>
              {!collapsedGroups.has(idx) && group.files && group.files.length > 0 && (
                <div className="px-3 pb-3 pt-1 space-y-1">
                  {group.files.map((file, fi) => (
                    <div key={fi} className="flex items-start gap-2 text-xs">
                      <code className="text-blue-300 shrink-0">{file.path}</code>
                      {file.label && (
                        <Badge variant="outline" className="text-[10px] px-1">
                          {file.label}
                        </Badge>
                      )}
                      {file.summary && (
                        <span className="text-muted-foreground">{file.summary}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
