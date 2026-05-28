import { useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { ChevronDownIcon } from '../icons';
import { api } from '../../lib/api';

interface TicketCompliance {
  ticket: string;
  status: 'compliant' | 'partially' | 'non-compliant';
}

export interface WalkthroughFile {
  path: string;
  label?: string;
  summary?: string;
}

export interface WalkthroughGroup {
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

interface WalkthroughHeaderProps {
  walkthrough: Walkthrough;
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

export function WalkthroughHeader({
  walkthrough,
  runId,
  taskId,
  onRefresh,
}: WalkthroughHeaderProps) {
  const g = walkthrough.global ?? {};
  const [collapsed, setCollapsed] = useState(false);
  const [editingSection, setEditingSection] = useState<{
    kind: 'summary' | 'key_review_points';
    value: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

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

  const hasContent =
    g.type ||
    g.risk ||
    g.effort !== undefined ||
    g.relevant_tests ||
    g.security_concerns ||
    g.summary ||
    (g.key_review_points && g.key_review_points.length > 0) ||
    (g.ticket_compliance && g.ticket_compliance.length > 0);
  if (!hasContent) return null;

  return (
    <section data-testid="walkthrough-header" className="border-b border-glass-edge bg-glass-l1">
      <header className="flex items-center justify-between gap-2 px-4 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={!collapsed}
          aria-controls="walkthrough-header-body"
        >
          <ChevronDownIcon
            className={collapsed ? '-rotate-90 transition-transform' : 'transition-transform'}
          />
          Walkthrough
        </button>
        {!collapsed && (g.type || g.risk || g.effort !== undefined || g.relevant_tests) && (
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
      </header>

      {!collapsed && (
        <div id="walkthrough-header-body" className="space-y-3 px-4 pb-3">
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
                    onChange={(e) =>
                      setEditingSection({ ...editingSection, value: e.target.value })
                    }
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

          {g.key_review_points && g.key_review_points.length > 0 && (
            <div>
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                    onChange={(e) =>
                      setEditingSection({ ...editingSection, value: e.target.value })
                    }
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
        </div>
      )}
    </section>
  );
}
