import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { InlineCommentWithOutdated, PostCommentInput } from '@/lib/api';
import type { Agent } from '../../server/types';
import { Button } from '@/components/ui/button';
import { InlineCommentThread } from '@/components/InlineCommentThread';

export interface OpenComposer {
  filePath: string;
  line: number;
  side: 'old' | 'new';
}

export interface QueuedDraft {
  filePath: string;
  line: number;
  side: 'old' | 'new';
  body: string;
  lineText: string;
}

export interface UseInlineCommentZonesParams {
  editor: MonacoEditor.IStandaloneDiffEditor | null;
  filePath: string;
  comments: InlineCommentWithOutdated[];
  agents: Agent[];
  rangeIsBase: boolean;
  outdatedUnavailable: boolean;
  openComposer: OpenComposer | null;
  onOpenComposer: (line: number, side: 'old' | 'new') => void;
  onCancelComposer: () => void;
  onPostComment: (input: PostCommentInput) => void | Promise<unknown>;
  onQueueDraft: (draft: QueuedDraft) => void;
  onReply: (parent: InlineCommentWithOutdated, body: string) => void;
  onResolve: (commentId: string, resolved: boolean) => void;
  onDelete: (commentId: string) => void;
  onEdit: (commentId: string, body: string) => void;
  focusedId?: string | null;
}

interface ZoneEntry {
  zoneId: string;
  domNode: HTMLDivElement;
  side: 'old' | 'new';
  line: number;
}

const ZONE_KEY = (line: number, side: 'old' | 'new') => `${side}:${line}`;

/**
 * Manages Monaco view zones for inline review comments. Returns an array of
 * React portals — the parent must render them so React updates the zone DOM nodes.
 *
 * Caller is responsible for keeping the editor alive; the hook removes its
 * zones on unmount.
 */
export function useInlineCommentZones(params: UseInlineCommentZonesParams): ReactNode[] {
  const {
    editor,
    filePath,
    comments,
    agents,
    rangeIsBase,
    outdatedUnavailable,
    openComposer,
    onOpenComposer,
    onCancelComposer,
    onPostComment,
    onQueueDraft,
    onReply,
    onResolve,
    onDelete,
    onEdit,
    focusedId,
  } = params;

  const zonesRef = useRef<Map<string, ZoneEntry>>(new Map());
  const composerZoneRef = useRef<{ key: string; zoneId: string; domNode: HTMLDivElement } | null>(
    null,
  );
  const observersRef = useRef<Map<string, ResizeObserver>>(new Map());
  // Bump on every successful zone mutation so the parent re-runs portal creation
  // with the latest domNode set.
  const [zoneTick, setZoneTick] = useState(0);

  // Index threads by (line, side)
  const threadsByKey = useMemo(() => {
    const m = new Map<string, InlineCommentWithOutdated[]>();
    for (const c of comments) {
      const k = ZONE_KEY(c.line, c.side);
      const arr = m.get(k);
      if (arr) arr.push(c);
      else m.set(k, [c]);
    }
    return m;
  }, [comments]);

  // ─── Sync persistent zones with the threadsByKey map ─────────────────────────
  useEffect(() => {
    if (!editor) return;
    const desiredKeys = new Set(threadsByKey.keys());
    const existing = zonesRef.current;

    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const k of desiredKeys) if (!existing.has(k)) toAdd.push(k);
    for (const k of existing.keys()) if (!desiredKeys.has(k)) toRemove.push(k);

    if (toAdd.length === 0 && toRemove.length === 0) return;

    const newDomNodes: {
      key: string;
      domNode: HTMLDivElement;
      side: 'old' | 'new';
      line: number;
    }[] = toAdd.map((k) => {
      const [side, lineStr] = k.split(':');
      const line = Number(lineStr);
      const domNode = document.createElement('div');
      domNode.className = 'octomux-comment-zone';
      domNode.dataset.zoneKey = k;
      return { key: k, domNode, side: side as 'old' | 'new', line };
    });

    const newEntries = new Map<string, ZoneEntry>();

    const apply = (ed: MonacoEditor.ICodeEditor, side: 'old' | 'new') => {
      ed.changeViewZones((accessor) => {
        for (const k of toRemove) {
          const entry = existing.get(k);
          if (!entry || entry.side !== side) continue;
          accessor.removeZone(entry.zoneId);
          existing.delete(k);
          observersRef.current.get(k)?.disconnect();
          observersRef.current.delete(k);
        }
        for (const node of newDomNodes) {
          if (node.side !== side) continue;
          const zoneId = accessor.addZone({
            afterLineNumber: node.line,
            heightInPx: 1,
            domNode: node.domNode,
            suppressMouseDown: true,
          });
          newEntries.set(node.key, {
            zoneId,
            domNode: node.domNode,
            side: node.side,
            line: node.line,
          });
        }
      });
    };

    apply(editor.getModifiedEditor(), 'new');
    apply(editor.getOriginalEditor(), 'old');

    for (const [k, e] of newEntries) existing.set(k, e);

    // Observe new DOM nodes for resize → update zone height.
    for (const node of newDomNodes) {
      const obs = new ResizeObserver(() => {
        const cur = zonesRef.current.get(node.key);
        if (!cur) return;
        const ed = node.side === 'new' ? editor.getModifiedEditor() : editor.getOriginalEditor();
        ed.changeViewZones((accessor) => {
          accessor.layoutZone(cur.zoneId);
        });
      });
      obs.observe(node.domNode);
      observersRef.current.set(node.key, obs);
    }

    setZoneTick((t) => t + 1);
  }, [editor, threadsByKey]);

  // ─── Composer transient zone ────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return;
    const wantsComposer = openComposer && openComposer.filePath === filePath;
    const composerKey = wantsComposer ? `composer:${openComposer.side}:${openComposer.line}` : null;
    const existing = composerZoneRef.current;

    if (!wantsComposer && !existing) return;

    if (wantsComposer && existing && existing.key === composerKey) return;

    const removeExisting = () => {
      if (!existing) return;
      const ed = existing.key.startsWith('composer:new:')
        ? editor.getModifiedEditor()
        : editor.getOriginalEditor();
      ed.changeViewZones((accessor) => accessor.removeZone(existing.zoneId));
      composerZoneRef.current = null;
    };

    if (!wantsComposer) {
      removeExisting();
      setZoneTick((t) => t + 1);
      return;
    }

    removeExisting();
    const domNode = document.createElement('div');
    domNode.className = 'octomux-comment-composer-zone';
    const ed =
      openComposer.side === 'new' ? editor.getModifiedEditor() : editor.getOriginalEditor();
    let zoneId = '';
    ed.changeViewZones((accessor) => {
      zoneId = accessor.addZone({
        afterLineNumber: openComposer.line,
        heightInPx: 1,
        domNode,
        suppressMouseDown: true,
      });
    });
    composerZoneRef.current = { key: composerKey!, zoneId, domNode };

    // Observe height changes
    const obs = new ResizeObserver(() => {
      const cur = composerZoneRef.current;
      if (!cur) return;
      ed.changeViewZones((accessor) => accessor.layoutZone(cur.zoneId));
    });
    obs.observe(domNode);
    observersRef.current.set(composerKey!, obs);

    setZoneTick((t) => t + 1);
    return () => {
      observersRef.current.get(composerKey!)?.disconnect();
      observersRef.current.delete(composerKey!);
    };
  }, [editor, openComposer, filePath]);

  // ─── Gutter "+" affordance ─────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return;
    const sub = editor.getModifiedEditor().onMouseDown((e) => {
      // Monaco MouseTargetType.GUTTER_LINE_NUMBERS = 4
      if (e.target.type !== 4) return;
      const line = e.target.position?.lineNumber;
      if (!line) return;
      const key = ZONE_KEY(line, 'new');
      if (threadsByKey.has(key)) return; // existing thread; let it render
      onOpenComposer(line, 'new');
    });
    return () => sub.dispose();
  }, [editor, threadsByKey, onOpenComposer]);

  // ─── Cleanup all zones on unmount ──────────────────────────────────────────
  useEffect(() => {
    const persistent = zonesRef.current;
    const observers = observersRef.current;
    return () => {
      const ed = editor;
      if (!ed) return;
      const newSide: string[] = [];
      const oldSide: string[] = [];
      for (const e of persistent.values()) (e.side === 'new' ? newSide : oldSide).push(e.zoneId);
      ed.getModifiedEditor().changeViewZones((accessor) => {
        for (const id of newSide) accessor.removeZone(id);
      });
      ed.getOriginalEditor().changeViewZones((accessor) => {
        for (const id of oldSide) accessor.removeZone(id);
      });
      persistent.clear();
      const composer = composerZoneRef.current;
      if (composer) {
        const cEd = composer.key.startsWith('composer:new:')
          ? ed.getModifiedEditor()
          : ed.getOriginalEditor();
        cEd.changeViewZones((accessor) => accessor.removeZone(composer.zoneId));
        composerZoneRef.current = null;
      }
      for (const obs of observers.values()) obs.disconnect();
      observers.clear();
    };
  }, [editor]);

  // ─── Build portals ─────────────────────────────────────────────────────────
  // zoneTick is a render trigger; we read zonesRef synchronously.
  void zoneTick;
  const portals: ReactNode[] = [];
  for (const [k, entry] of zonesRef.current) {
    const list = threadsByKey.get(k);
    if (!list || list.length === 0) continue;
    portals.push(
      createPortal(
        <InlineCommentThread
          comments={list}
          agents={agents}
          rangeIsBase={rangeIsBase}
          outdatedUnavailable={outdatedUnavailable}
          focusedId={focusedId ?? null}
          onReply={(body) => onReply(list[list.length - 1], body)}
          onResolve={onResolve}
          onDelete={onDelete}
          onEdit={onEdit}
        />,
        entry.domNode,
        `zone-${filePath}-${k}`,
      ),
    );
  }

  if (composerZoneRef.current && openComposer && openComposer.filePath === filePath) {
    portals.push(
      createPortal(
        <InlineComposer
          line={openComposer.line}
          side={openComposer.side}
          filePath={filePath}
          editor={editor}
          onPostComment={onPostComment}
          onQueueDraft={onQueueDraft}
          onCancel={onCancelComposer}
        />,
        composerZoneRef.current.domNode,
        `composer-${filePath}-${composerZoneRef.current.key}`,
      ),
    );
  }

  return portals;
}

interface InlineComposerProps {
  line: number;
  side: 'old' | 'new';
  filePath: string;
  editor: MonacoEditor.IStandaloneDiffEditor | null;
  onPostComment: (input: PostCommentInput) => void | Promise<unknown>;
  onQueueDraft: (draft: QueuedDraft) => void;
  onCancel: () => void;
}

function lineTextAt(
  editor: MonacoEditor.IStandaloneDiffEditor | null,
  line: number,
  side: 'old' | 'new',
): string {
  if (!editor) return '';
  const ed = side === 'new' ? editor.getModifiedEditor() : editor.getOriginalEditor();
  const model = ed.getModel();
  if (!model) return '';
  try {
    return model.getLineContent(line);
  } catch {
    return '';
  }
}

function InlineComposer({
  line,
  side,
  filePath,
  editor,
  onPostComment,
  onQueueDraft,
  onCancel,
}: InlineComposerProps) {
  const [draft, setDraft] = useState('');

  return (
    <div className="bg-glass-l1 glass-blur-l1 m-2 border border-glass-edge p-2">
      <textarea
        autoFocus
        aria-label="New comment"
        placeholder="Leave a comment"
        className="w-full border border-glass-edge bg-glass-l1 px-2 py-1 text-sm"
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="mt-1 flex items-center justify-end gap-1 text-[11px]">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!draft.trim()}
          onClick={() => {
            onQueueDraft({
              filePath,
              line,
              side,
              body: draft,
              lineText: lineTextAt(editor, line, side),
            });
            setDraft('');
            onCancel();
          }}
        >
          Add to review
        </Button>
        <Button
          size="xs"
          disabled={!draft.trim()}
          onClick={() => {
            onPostComment({ file_path: filePath, line, side, body: draft });
            setDraft('');
            onCancel();
          }}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}
