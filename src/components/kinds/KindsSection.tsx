/**
 * Settings → Kinds (spec/schedule-kinds-as-presets.md §6.1). Replaces the
 * deleted "Schedule skills" section. Lists all presets (built-in + home),
 * with New/Edit/Copy-to-custom/Delete/Export/Import — the kind editor takes
 * raw JSON in a validated textarea for `config`/`output`; no schema-builder
 * UI (explicitly out of scope, §1.1).
 */
import { useCallback, useEffect, useState } from 'react';
import { kindsApi, type Preset, type PresetWithSource } from '@/lib/api/kindsApi';
import { showToast } from '@/components/CustomToast';
import { SectionCard } from '@/components/layout/section-card';
import { AddChip } from '@/components/layout/add-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CronPresetField } from '@/components/schedules/CronPresetField';
import { ROW_DIVIDER } from '@/lib/design-tokens';

function emptyDraft(): Preset {
  return { kind: '', displayName: '', execution: 'session', defaultCron: '', prompt: '' };
}

function jsonTextFromSchema(schema: Record<string, unknown> | undefined): string {
  return schema ? JSON.stringify(schema, null, 2) : '';
}

interface EditorTarget {
  /** True when editing an existing home preset in place — the kind id (and
   * hence the target file) can't change, since PUT requires body.kind to
   * equal the URL param. */
  kindLocked: boolean;
  draft: Preset;
}

// ─── Editor dialog (New / Edit / Copy to custom) ──────────────────────────────

function PresetEditorDialog({
  target,
  onClose,
  onSaved,
}: {
  target: EditorTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [defaultCron, setDefaultCron] = useState('');
  const [prompt, setPrompt] = useState('');
  const [configText, setConfigText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setKind(target.draft.kind);
    setDisplayName(target.draft.displayName);
    setDefaultCron(target.draft.defaultCron ?? '');
    setPrompt(target.draft.prompt ?? '');
    setConfigText(jsonTextFromSchema(target.draft.config));
    setOutputText(jsonTextFromSchema(target.draft.output));
    setConfigError(null);
    setOutputError(null);
    setError(null);
  }, [target]);

  const validateJson = useCallback((text: string, setErr: (e: string | null) => void) => {
    if (!text.trim()) {
      setErr(null);
      return;
    }
    try {
      JSON.parse(text);
      setErr(null);
    } catch (err) {
      setErr((err as Error).message || 'Invalid JSON');
    }
  }, []);

  const canSubmit =
    kind.trim().length > 0 &&
    displayName.trim().length > 0 &&
    !configError &&
    !outputError &&
    !saving;

  const handleSave = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const body: Preset = {
        kind: kind.trim(),
        displayName: displayName.trim(),
        execution: 'session',
        ...(defaultCron.trim() ? { defaultCron: defaultCron.trim() } : {}),
        ...(prompt.trim() ? { prompt } : {}),
        ...(configText.trim() ? { config: JSON.parse(configText) } : {}),
        ...(outputText.trim() ? { output: JSON.parse(outputText) } : {}),
      };
      await kindsApi.savePreset(kind.trim(), body);
      onSaved();
    } catch (err) {
      setError((err as Error).message || 'Failed to save kind');
    } finally {
      setSaving(false);
    }
  }, [canSubmit, kind, displayName, defaultCron, prompt, configText, outputText, onSaved]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="kind-editor-dialog"
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{target?.kindLocked ? 'Edit kind' : 'New kind'}</DialogTitle>
          <DialogDescription>
            Presets are copied into each schedule at create time — editing this never touches
            existing schedules.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind-editor-id">Kind id</Label>
            <Input
              id="kind-editor-id"
              data-testid="kind-editor-id"
              className="font-mono text-sm"
              placeholder="my-custom-kind"
              value={kind}
              disabled={target?.kindLocked}
              onChange={(e) => setKind(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind-editor-display-name">Display name</Label>
            <Input
              id="kind-editor-display-name"
              data-testid="kind-editor-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <CronPresetField
            id="kind-editor-cron"
            value={defaultCron}
            onChange={setDefaultCron}
            presetTestId="kind-editor-cron-preset"
            customTestId="kind-editor-cron-custom"
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind-editor-prompt">Prompt</Label>
            <Textarea
              id="kind-editor-prompt"
              data-testid="kind-editor-prompt"
              rows={6}
              className="font-mono text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind-editor-config">Config JSON Schema (optional)</Label>
            <Textarea
              id="kind-editor-config"
              data-testid="kind-editor-config"
              rows={5}
              className="font-mono text-xs"
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              onBlur={() => validateJson(configText, setConfigError)}
            />
            {configError && (
              <p className="text-xs text-destructive" data-testid="kind-editor-config-error">
                {configError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind-editor-output">Output JSON Schema (optional)</Label>
            <Textarea
              id="kind-editor-output"
              data-testid="kind-editor-output"
              rows={5}
              className="font-mono text-xs"
              value={outputText}
              onChange={(e) => setOutputText(e.target.value)}
              onBlur={() => validateJson(outputText, setOutputError)}
            />
            {outputError && (
              <p className="text-xs text-destructive" data-testid="kind-editor-output-error">
                {outputError}
              </p>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button data-testid="kind-editor-save" disabled={!canSubmit} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Import dialog ─────────────────────────────────────────────────────────────

function ImportKindDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleImport = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.kind !== 'string' || !parsed.kind.trim()) {
        throw new Error('JSON must include a string "kind" field');
      }
      await kindsApi.savePreset(parsed.kind, parsed as unknown as Preset);
      setText('');
      onImported();
    } catch (err) {
      setError((err as Error).message || 'Failed to import kind');
    } finally {
      setSaving(false);
    }
  }, [text, onImported]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="kind-import-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import kind JSON</DialogTitle>
          <DialogDescription>
            Paste a preset JSON object exported from another kind.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          data-testid="kind-import-textarea"
          rows={12}
          className="font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"kind": "...", "displayName": "...", "execution": "session", ...}'
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            data-testid="kind-import-submit"
            disabled={!text.trim() || saving}
            onClick={handleImport}
          >
            {saving ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

export function KindsSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [presets, setPresets] = useState<PresetWithSource[] | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PresetWithSource | null>(null);

  const load = useCallback(() => {
    kindsApi.listKinds().then((res) => setPresets(res.kinds));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleEdit = useCallback((p: PresetWithSource) => {
    if (p.source === 'home') {
      setEditorTarget({ kindLocked: true, draft: p });
    } else {
      // Built-in: "Copy to custom" clones it under a new kind id (§6.1).
      setEditorTarget({ kindLocked: false, draft: { ...p, kind: `${p.kind}-custom` } });
    }
  }, []);

  const handleExport = useCallback(async (p: PresetWithSource) => {
    const { source: _source, ...preset } = p;
    try {
      await navigator.clipboard.writeText(JSON.stringify(preset, null, 2));
      showToast('success', 'COPIED', `${p.kind} preset JSON copied to clipboard.`);
    } catch (err) {
      showToast(
        'error',
        'COPY FAILED',
        (err as Error).message || 'Could not access the clipboard.',
      );
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await kindsApi.deletePreset(deleteTarget.kind);
      setDeleteTarget(null);
      load();
    } catch (err) {
      showToast('error', 'DELETE FAILED', (err as Error).message || 'Could not delete kind.');
    }
  }, [deleteTarget, load]);

  return (
    <SectionCard
      id="kinds"
      title="Kinds"
      help="Presets copied into each schedule at create time — editing a preset never touches existing schedules."
      count={presets ? presets.length : undefined}
      scrollRef={scrollRef}
      trailing={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="kind-import-open"
            onClick={() => setImportOpen(true)}
          >
            Import JSON
          </Button>
          <AddChip
            label="+ New kind"
            onClick={() => setEditorTarget({ kindLocked: false, draft: emptyDraft() })}
          />
        </div>
      }
    >
      {presets === null ? (
        <p className="py-6 text-center text-sm text-[#8a8a8a]" data-testid="kinds-loading">
          Loading…
        </p>
      ) : (
        <div data-testid="kinds-list">
          {presets.map((p) => (
            <div
              key={p.kind}
              data-testid={`kind-row-${p.kind}`}
              className="flex items-center justify-between gap-2 py-3"
              style={ROW_DIVIDER}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {p.displayName}
                </span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {p.kind}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {p.source === 'builtin' ? 'built-in' : 'custom'}
                </Badge>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`kind-export-${p.kind}`}
                  onClick={() => handleExport(p)}
                >
                  Export
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`kind-edit-${p.kind}`}
                  onClick={() => handleEdit(p)}
                >
                  {p.source === 'builtin' ? 'Copy to custom' : 'Edit'}
                </Button>
                {p.source === 'home' && (
                  <button
                    type="button"
                    data-testid={`kind-delete-${p.kind}`}
                    className="text-xs text-destructive hover:underline"
                    onClick={() => setDeleteTarget(p)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <PresetEditorDialog
        target={editorTarget}
        onClose={() => setEditorTarget(null)}
        onSaved={() => {
          setEditorTarget(null);
          load();
        }}
      />
      <ImportKindDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          load();
        }}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent data-testid="confirm-delete-kind" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete kind?</DialogTitle>
            <DialogDescription>
              This removes the custom preset{' '}
              <span className="font-mono text-foreground">{deleteTarget?.kind}</span>. Existing
              schedules created from it are unaffected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="confirm-delete-kind-confirm"
              onClick={handleDelete}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
