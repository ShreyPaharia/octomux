import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { schedulesApi, type ScheduleKindInfo, type ScheduleRow } from '@/lib/api/schedulesApi';
import type { WorkflowRunRow } from '@/lib/api/workflowsApi';
import { useResource } from '@/lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormSelect } from '@/components/ui/form-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/layout/page-header';
import { timeAgo } from '@/lib/time';
import { SchemaConfigForm, defaultsFromSchema } from '@/components/schedules/SchemaConfigForm';
import { CronPresetField } from '@/components/schedules/CronPresetField';
import { CRON_PRESETS } from '@/components/schedules/cronPresets';
import { RepoPickerField } from '@/components/fields/RepoPickerField';
import { TimezoneField } from '@/components/schedules/TimezoneField';
import { KNOWN_MODELS } from '@/lib/models';

function parseConfigJson(configJson: string | null): Record<string, unknown> {
  if (!configJson) return {};
  try {
    return JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Convert timeout_ms (stored) to minutes (displayed). Returns '' for null. */
function msToMinutes(ms: number | null | undefined): string {
  if (ms == null) return '';
  return String(Math.round(ms / 60_000));
}

/** Convert displayed minutes string to ms. Returns undefined for empty/invalid. */
function minutesToMs(mins: string): number | undefined {
  const n = Number.parseInt(mins, 10);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return n * 60_000;
}

// ─── Models datalist ──────────────────────────────────────────────────────────

function ModelsDatalist({ id }: { id: string }) {
  return (
    <datalist id={id}>
      {KNOWN_MODELS.map((m) => (
        <option key={m} value={m} />
      ))}
    </datalist>
  );
}

// ─── ScheduleForm (create panel) ─────────────────────────────────────────────

function ScheduleForm({ kinds, onCreated }: { kinds: ScheduleKindInfo[]; onCreated: () => void }) {
  const [kind, setKind] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [cron, setCron] = useState(CRON_PRESETS[0].cron);
  const [timezone, setTimezone] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [timeoutMins, setTimeoutMins] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedKind = useMemo(() => kinds.find((k) => k.kind === kind) ?? null, [kinds, kind]);
  const isCustom = kind === 'custom';

  useEffect(() => {
    if (!kind && kinds.length > 0) setKind(kinds[0].kind);
  }, [kind, kinds]);

  useEffect(() => {
    if (!selectedKind?.configSchema) {
      setConfig({});
      return;
    }
    setConfig(defaultsFromSchema(selectedKind.configSchema));
  }, [selectedKind]);

  const canSubmit =
    kind.length > 0 &&
    repoPath.trim().length > 0 &&
    cron.trim().length > 0 &&
    // custom requires both name and prompt
    (!isCustom || (name.trim().length > 0 && prompt.trim().length > 0));

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const payloadConfig =
        selectedKind?.configSchema && Object.keys(config).length > 0 ? config : undefined;
      const timeoutMs = minutesToMs(timeoutMins);

      await schedulesApi.createSchedule({
        kind,
        repoPath: repoPath.trim(),
        cron: cron.trim(),
        enabled,
        ...(payloadConfig ? { config: payloadConfig } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(timezone ? { timezone } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(timeoutMs != null ? { timeoutMs } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });

      setRepoPath('');
      setCron(CRON_PRESETS[0].cron);
      setTimezone('');
      setEnabled(true);
      setName('');
      setModel('');
      setTimeoutMins('');
      setPrompt('');
      if (selectedKind?.configSchema) {
        setConfig(defaultsFromSchema(selectedKind.configSchema));
      } else {
        setConfig({});
      }
      onCreated();
    } catch (err) {
      setError((err as Error).message || 'Failed to create schedule');
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    kind,
    repoPath,
    cron,
    timezone,
    enabled,
    config,
    name,
    model,
    timeoutMins,
    prompt,
    selectedKind,
    onCreated,
  ]);

  return (
    <GlassPanel level={2} className="flex flex-col gap-3 rounded-2xl p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-kind">Kind</Label>
          <FormSelect
            id="schedule-kind"
            data-testid="schedule-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.displayName}
              </option>
            ))}
          </FormSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-path">Repository</Label>
          <RepoPickerField value={repoPath} onChange={setRepoPath} />
        </div>
        <CronPresetField value={cron} onChange={setCron} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TimezoneField value={timezone} onChange={setTimezone} />
      </div>

      {/* Custom kind: name + prompt always visible and required */}
      {isCustom && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-name-custom">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="schedule-name-custom"
              data-testid="schedule-name"
              placeholder="My custom schedule"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-prompt-custom">
              Prompt <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="schedule-prompt-custom"
              data-testid="schedule-prompt"
              placeholder="What should the agent do on each run?"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        </div>
      )}

      <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer accent-[#3B82F6]"
        />
        Enabled
      </label>

      {selectedKind?.configSchema ? (
        <details className="group" open>
          <summary className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            Workflow config
          </summary>
          <div className="mt-3">
            <SchemaConfigForm
              schema={selectedKind.configSchema}
              value={config}
              onChange={setConfig}
            />
          </div>
        </details>
      ) : null}

      {/* Advanced: name (for built-ins), model, timeout */}
      <details className="group">
        <summary className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          {/* Name only shown here for non-custom kinds */}
          {!isCustom && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-name">Name (optional)</Label>
              <Input
                id="schedule-name"
                data-testid="schedule-name"
                placeholder="Leave blank to use kind display name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-model">Model (optional)</Label>
            <ModelsDatalist id="schedule-models-list" />
            <Input
              id="schedule-model"
              data-testid="schedule-model"
              list="schedule-models-list"
              placeholder="Harness default"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          {selectedKind?.supportsTimeout && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-timeout">Timeout (minutes, optional)</Label>
              <Input
                id="schedule-timeout"
                data-testid="schedule-timeout"
                type="number"
                min={1}
                placeholder="5"
                value={timeoutMins}
                onChange={(e) => setTimeoutMins(e.target.value)}
              />
              <p className="text-[10px] text-muted-soft">
                Defaults to 5 minutes (300 s). Min 10 s, max 24 h.
              </p>
            </div>
          )}
        </div>
      </details>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div>
        <Button
          size="sm"
          data-testid="schedule-submit"
          disabled={!canSubmit || submitting}
          onClick={handleSubmit}
        >
          {submitting ? 'Creating…' : 'New schedule'}
        </Button>
        {isCustom && (!name.trim() || !prompt.trim()) && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Name and prompt are required for custom schedules.
          </p>
        )}
      </div>
    </GlassPanel>
  );
}

// ─── Runs list ────────────────────────────────────────────────────────────────

function runDestination(run: WorkflowRunRow): string | null {
  if (run.task_id) return `/tasks/${run.task_id}`;
  if (run.chat_id) return `/chats/${run.chat_id}`;
  if (run.loop_run_id) return `/w/loops/${run.loop_run_id}`;
  return null;
}

function ScheduleRuns({ scheduleId }: { scheduleId: string }) {
  const nav = useNavigate();
  const [runs, setRuns] = useState<WorkflowRunRow[] | null>(null);

  const refresh = useCallback(() => {
    schedulesApi.getScheduleRuns(scheduleId).then((res) => setRuns(res.runs));
  }, [scheduleId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (runs === null) {
    return <p className="px-4 py-2 text-xs text-muted-foreground">Loading runs…</p>;
  }
  if (runs.length === 0) {
    return <p className="px-4 py-2 text-xs text-muted-foreground">No runs yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1 px-4 py-2">
      {runs.map((run) => {
        const dest = runDestination(run);
        const label = `${run.workflow_kind} · ${run.trigger}`;
        return (
          <li
            key={run.id}
            data-testid={`schedule-run-${run.id}`}
            className="flex items-center gap-2 text-xs"
          >
            {dest ? (
              <button
                type="button"
                className="truncate text-foreground hover:text-primary hover:underline"
                onClick={() => nav(dest)}
              >
                {label}
              </button>
            ) : (
              <span className="truncate text-foreground">{label}</span>
            )}
            <Badge variant="outline" className="text-[10px]">
              {run.effective_status}
            </Badge>
            <span className="text-muted-soft">{timeAgo(run.started_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Prompt override editor ───────────────────────────────────────────────────

function PromptOverrideEditor({
  scheduleId,
  currentPrompt,
  onSave,
}: {
  scheduleId: string;
  currentPrompt: string | null;
  onSave: (prompt: string | null) => Promise<void>;
}) {
  const [mode, setMode] = useState<'collapsed' | 'preview' | 'editing'>('collapsed');
  const [preview, setPreview] = useState<{
    content: string;
    source: 'override' | 'kind_skill';
  } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const fetchPreview = useCallback(() => {
    schedulesApi.getEffectivePrompt(scheduleId).then((res) => setPreview(res));
  }, [scheduleId]);

  const handleExpand = useCallback(() => {
    setMode('preview');
    fetchPreview();
  }, [fetchPreview]);

  const handleOverride = useCallback(() => {
    if (preview) {
      setEditValue(preview.content);
    }
    setMode('editing');
  }, [preview]);

  const handleSaveOverride = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(editValue.trim() || null);
      setMode('preview');
      fetchPreview();
    } finally {
      setSaving(false);
    }
  }, [editValue, onSave, fetchPreview]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(null);
      setConfirmReset(false);
      setMode('preview');
      fetchPreview();
    } finally {
      setSaving(false);
    }
  }, [onSave, fetchPreview]);

  if (mode === 'collapsed') {
    return (
      <button
        type="button"
        data-testid="prompt-override-expand"
        className="text-xs text-muted-foreground hover:text-foreground"
        onClick={handleExpand}
      >
        {currentPrompt ? '▸ Edit prompt override' : '▸ Override prompt'}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="prompt-override-panel">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          Prompt{' '}
          {preview?.source === 'override' ? (
            <Badge variant="outline" className="text-[10px]">
              override
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              kind default
            </Badge>
          )}
        </p>
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setMode('collapsed')}
        >
          Collapse
        </button>
      </div>

      {mode === 'preview' && (
        <>
          {preview ? (
            <pre
              data-testid="prompt-preview"
              className="max-h-48 overflow-auto rounded-lg border border-glass-edge bg-glass-l1 p-3 font-mono text-[11px] text-foreground"
            >
              {preview.content}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
          <p className="text-[10px] text-muted-soft">
            {'{{tokens}}'} are replaced at runtime by the config value with the same name.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="prompt-override-btn"
              onClick={handleOverride}
            >
              Override
            </Button>
            {currentPrompt && (
              <Button
                size="sm"
                variant="outline"
                data-testid="prompt-reset-btn"
                onClick={() => setConfirmReset(true)}
              >
                Reset to kind default
              </Button>
            )}
          </div>
          {confirmReset && (
            <div className="flex items-center gap-2 rounded-lg border border-glass-edge bg-glass-l1 p-3 text-xs">
              <span>Remove your prompt override and use the kind default?</span>
              <Button
                size="sm"
                variant="destructive"
                data-testid="prompt-reset-confirm"
                disabled={saving}
                onClick={handleReset}
              >
                Reset
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmReset(false)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          )}
        </>
      )}

      {mode === 'editing' && (
        <>
          <Textarea
            data-testid="prompt-override-textarea"
            rows={8}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="font-mono text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              data-testid="prompt-override-save"
              disabled={saving}
              onClick={handleSaveOverride}
            >
              {saving ? 'Saving…' : 'Save override'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setMode('preview');
                fetchPreview();
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── ScheduleDetail (edit card) ───────────────────────────────────────────────

function ScheduleDetail({
  row,
  kindInfo,
  onSaved,
  onRunStarted,
}: {
  row: ScheduleRow;
  kindInfo: ScheduleKindInfo | null;
  onSaved: () => void;
  onRunStarted: () => void;
}) {
  const [cron, setCron] = useState(row.cron);
  const [enabled, setEnabled] = useState(row.enabled === 1);
  const [config, setConfig] = useState<Record<string, unknown>>(() =>
    parseConfigJson(row.config_json),
  );
  const [repoPath, setRepoPath] = useState(row.repo_path);
  const [name, setName] = useState(row.name ?? '');
  const [timezone, setTimezone] = useState(row.timezone ?? '');
  const [model, setModel] = useState(row.model ?? '');
  const [timeoutMins, setTimeoutMins] = useState(msToMinutes(row.timeout_ms));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCron(row.cron);
    setEnabled(row.enabled === 1);
    setConfig(parseConfigJson(row.config_json));
    setRepoPath(row.repo_path);
    setName(row.name ?? '');
    setTimezone(row.timezone ?? '');
    setModel(row.model ?? '');
    setTimeoutMins(msToMinutes(row.timeout_ms));
  }, [row]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const timeoutMs = minutesToMs(timeoutMins);
      await schedulesApi.updateSchedule(row.id, {
        cron: cron.trim(),
        enabled,
        repoPath: repoPath.trim() || undefined,
        name: name.trim() ? name.trim() : null,
        timezone: timezone || null,
        model: model.trim() ? model.trim() : null,
        timeoutMs: timeoutMs != null ? timeoutMs : null,
        ...(kindInfo?.configSchema ? { config } : {}),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message || 'Failed to save schedule');
    } finally {
      setSaving(false);
    }
  }, [
    row.id,
    cron,
    enabled,
    repoPath,
    name,
    timezone,
    model,
    timeoutMins,
    config,
    kindInfo,
    onSaved,
  ]);

  const handlePromptSave = useCallback(
    async (prompt: string | null) => {
      await schedulesApi.updateSchedule(row.id, { prompt });
      onSaved();
    },
    [row.id, onSaved],
  );

  const handleRunNow = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      await schedulesApi.runScheduleNow(row.id);
      onRunStarted();
    } catch (err) {
      setError((err as Error).message || 'Failed to trigger run');
    } finally {
      setRunning(false);
    }
  }, [row.id, onRunStarted]);

  return (
    <div className="flex flex-col gap-4 border-t border-glass-edge pt-3">
      {/* Kind badge — immutable */}
      <div className="flex items-center gap-2">
        <p className="text-[10px] text-muted-foreground">Kind</p>
        <Badge variant="outline" className="font-mono text-[10px]">
          {row.kind}
        </Badge>
        <p className="text-[10px] text-muted-soft">(immutable — delete and recreate to change)</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CronPresetField
          id={`schedule-edit-cron-${row.id}`}
          value={cron}
          onChange={setCron}
          presetTestId={`schedule-edit-cron-preset-${row.id}`}
          customTestId={`schedule-edit-cron-${row.id}`}
        />
        <TimezoneField
          id={`schedule-edit-timezone-${row.id}`}
          value={timezone}
          onChange={setTimezone}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`schedule-edit-name-${row.id}`}>Name</Label>
          <Input
            id={`schedule-edit-name-${row.id}`}
            data-testid={`schedule-edit-name-${row.id}`}
            placeholder={kindInfo?.displayName ?? row.kind}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {/* Repo path */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`schedule-edit-repo-${row.id}`}>Repository</Label>
          <Input
            id={`schedule-edit-repo-${row.id}`}
            data-testid={`schedule-edit-repo-${row.id}`}
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Model */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`schedule-edit-model-${row.id}`}>Model</Label>
          <ModelsDatalist id={`schedule-edit-models-list-${row.id}`} />
          <Input
            id={`schedule-edit-model-${row.id}`}
            data-testid={`schedule-edit-model-${row.id}`}
            list={`schedule-edit-models-list-${row.id}`}
            placeholder="Harness default"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        {/* Timeout — only when supportsTimeout */}
        {kindInfo?.supportsTimeout && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`schedule-edit-timeout-${row.id}`}>Timeout (minutes)</Label>
            <Input
              id={`schedule-edit-timeout-${row.id}`}
              data-testid={`schedule-edit-timeout-${row.id}`}
              type="number"
              min={1}
              placeholder="5"
              value={timeoutMins}
              onChange={(e) => setTimeoutMins(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={enabled}
            onChange={setEnabled}
            aria-label={`Enable ${row.kind} schedule`}
          />
          Enabled
        </label>
      </div>

      {kindInfo?.configSchema ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Workflow config</p>
          <SchemaConfigForm schema={kindInfo.configSchema} value={config} onChange={setConfig} />
        </div>
      ) : null}

      {/* Prompt override editor */}
      <PromptOverrideEditor
        scheduleId={row.id}
        currentPrompt={row.prompt ?? null}
        onSave={handlePromptSave}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid={`schedule-save-${row.id}`}
          disabled={saving || !cron.trim()}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid={`schedule-run-now-${row.id}`}
          disabled={running}
          onClick={handleRunNow}
        >
          {running ? 'Starting…' : 'Run now'}
        </Button>
      </div>

      <div>
        <p className="px-4 pb-1 text-xs font-medium text-muted-foreground">Run history</p>
        <ScheduleRuns scheduleId={row.id} />
      </div>
    </div>
  );
}

// ─── Delete dialog ────────────────────────────────────────────────────────────

function ScheduleDeleteDialog({
  schedule,
  kindDisplayName,
  onOpenChange,
  onConfirm,
}: {
  schedule: ScheduleRow | null;
  kindDisplayName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const label = schedule ? (schedule.name ?? kindDisplayName) : '';
  return (
    <Dialog open={schedule !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="confirm-delete-schedule" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete schedule?</DialogTitle>
          <DialogDescription>
            This stops <span className="font-medium text-foreground">{label}</span>{' '}
            <span className="font-mono text-muted-foreground">{schedule?.cron}</span> from firing.
            Past runs are unaffected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-schedule-confirm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Card title logic ─────────────────────────────────────────────────────────

/**
 * Returns the card title for a schedule row.
 * - Shows `name ?? displayName` as the main text.
 * - Appends the cron in monospace when two unnamed rows share (kind, repo_path).
 */
function cardTitle(
  row: ScheduleRow,
  displayName: string,
  allSchedules: ScheduleRow[],
): { title: string; showCron: boolean } {
  const title = row.name ?? displayName;
  // Multi-instance disambiguation: when two unnamed rows share (kind, repo_path)
  const hasCollision =
    !row.name &&
    allSchedules.some(
      (other) =>
        other.id !== row.id &&
        other.kind === row.kind &&
        other.repo_path === row.repo_path &&
        !other.name,
    );
  return { title, showCron: hasCollision };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SchedulesPage() {
  const [searchParams] = useSearchParams();
  const { data, loading, refresh } = useResource<ScheduleRow[]>('schedules', () =>
    schedulesApi.listSchedules(),
  );
  const [kinds, setKinds] = useState<ScheduleKindInfo[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(() => searchParams.get('expand'));
  const [deleteTarget, setDeleteTarget] = useState<ScheduleRow | null>(null);
  const [runsKey, setRunsKey] = useState(0);
  const schedules = data ?? [];

  const kindByName = useMemo(() => new Map(kinds.map((k) => [k.kind, k])), [kinds]);

  useEffect(() => {
    schedulesApi.getScheduleKinds().then((res) => setKinds(res.kinds));
  }, []);

  const handleToggle = useCallback(
    async (row: ScheduleRow) => {
      await schedulesApi.updateSchedule(row.id, { enabled: row.enabled !== 1 });
      refresh();
    },
    [refresh],
  );

  const deleteKindInfo = deleteTarget ? (kindByName.get(deleteTarget.kind) ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <PageHeader
        title="Schedules"
        description="Cron-triggered runs — creatable and observable from here."
      />

      <ScheduleForm kinds={kinds} onCreated={refresh} />

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-2xl border border-glass-edge bg-glass-l1"
            />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No schedules yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {schedules.map((row) => {
            const kindInfo = kindByName.get(row.kind) ?? null;
            const displayName = kindInfo?.displayName ?? row.kind;
            const { title, showCron } = cardTitle(row, displayName, schedules);
            return (
              <li key={row.id}>
                <GlassPanel
                  level={2}
                  specular
                  data-testid={`schedule-row-${row.id}`}
                  className="flex flex-col gap-2 rounded-2xl px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`schedule-expand-${row.id}`}
                      className="truncate text-sm font-medium text-foreground hover:text-primary"
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    >
                      {title}
                    </button>
                    {/* Kind badge */}
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {row.kind}
                    </Badge>
                    <span className="truncate text-xs text-muted-foreground">{row.repo_path}</span>
                    <Badge variant="outline" className="font-mono">
                      {row.cron}
                    </Badge>
                    {/* Disambiguation: cron in monospace when two unnamed rows collide */}
                    {showCron && (
                      <span className="font-mono text-[10px] text-muted-soft">{row.cron}</span>
                    )}
                    <span className="text-[10px] text-muted-soft">
                      {row.last_run_at ? `last run ${timeAgo(row.last_run_at)}` : 'never run'}
                    </span>
                    <div className="ml-auto flex items-center gap-3">
                      <Switch
                        checked={row.enabled === 1}
                        onChange={() => handleToggle(row)}
                        aria-label={`Toggle ${row.kind} schedule`}
                      />
                      <button
                        type="button"
                        data-testid={`schedule-delete-${row.id}`}
                        className="text-xs text-destructive hover:underline"
                        onClick={() => setDeleteTarget(row)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {expandedId === row.id && (
                    <ScheduleDetail
                      key={`${row.id}-${runsKey}`}
                      row={row}
                      kindInfo={kindInfo}
                      onSaved={refresh}
                      onRunStarted={() => {
                        setRunsKey((k) => k + 1);
                        refresh();
                      }}
                    />
                  )}
                </GlassPanel>
              </li>
            );
          })}
        </ul>
      )}

      <ScheduleDeleteDialog
        schedule={deleteTarget}
        kindDisplayName={deleteKindInfo?.displayName ?? deleteTarget?.kind ?? ''}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await schedulesApi.deleteSchedule(deleteTarget.id);
          refresh();
        }}
      />
    </div>
  );
}
