import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  schedulesApi,
  type ImportScheduleInput,
  type ScheduleKindInfo,
  type ScheduleRow,
} from '@/lib/api/schedulesApi';
import { kindsApi, type PresetWithSource } from '@/lib/api/kindsApi';
import type { WorkflowRunRow } from '@/lib/api/workflowsApi';
import { useResource } from '@/lib/use-resource';
import { showToast } from '@/components/CustomToast';
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
import { CronScheduleField } from '@/components/schedules/CronScheduleField';
import { DEFAULT_CRON } from '@/components/schedules/cronBuilder';
import { RepoPickerField } from '@/components/fields/RepoPickerField';
import { TimezoneField } from '@/components/schedules/TimezoneField';
import { KNOWN_MODELS } from '@/lib/models';
import { cn } from '@/lib/utils';

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

// ─── Section heading ──────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</p>
  );
}

// ─── Trigger picker ───────────────────────────────────────────────────────────

/**
 * Only `schedule` (cron) is wired end-to-end — the `schedules` table stores a
 * cron and nothing else. GitHub/Linear are shown disabled so the surface is
 * honest about what exists rather than hiding the roadmap.
 */
const TRIGGERS = [
  { id: 'schedule', label: 'Schedule', hint: 'Run on a recurring cron schedule' },
  { id: 'github', label: 'GitHub event', hint: 'Run when a GitHub webhook event fires' },
  { id: 'linear', label: 'Linear event', hint: 'Run when a Linear issue changes' },
] as const;

function TriggerPicker({
  cron,
  onCronChange,
  timezone,
  timezoneField,
}: {
  cron: string;
  onCronChange: (cron: string) => void;
  timezone: string;
  timezoneField: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {TRIGGERS.map((trigger) => {
        const active = trigger.id === 'schedule';
        return (
          <div
            key={trigger.id}
            data-testid={`schedule-trigger-${trigger.id}`}
            className={cn(
              'rounded-xl border px-3.5 py-3',
              active ? 'border-primary/50 bg-glass-l1' : 'border-glass-edge opacity-50',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{trigger.label}</span>
              {!active && (
                <span className="ml-auto text-[10px] text-muted-soft">Not available yet</span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{trigger.hint}</p>
            {active && (
              <div className="mt-3 flex flex-col gap-3">
                <CronScheduleField value={cron} onChange={onCronChange} timezone={timezone} />
                {timezoneField}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Create dialog ────────────────────────────────────────────────────────────

function ScheduleDialog({
  open,
  onClose,
  kinds,
  presets,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  kinds: ScheduleKindInfo[];
  presets: PresetWithSource[];
  onCreated: () => void;
}) {
  const [kind, setKind] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [cron, setCron] = useState(DEFAULT_CRON);
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
  const selectedPreset = useMemo(
    () => presets.find((p) => p.kind === kind) ?? null,
    [presets, kind],
  );
  // A kind is a preset (spec §1) — every capability check is driven by the
  // API's derived flags, never a hardcoded kind name (§7 kind-agnosticism).
  const promptRequired = selectedKind?.promptRequired ?? false;

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

  // The prompt is copied from the preset at create time (§1) — pre-fill it
  // here so the copy is visible and editable, never an invisible default (§7.1).
  useEffect(() => {
    setPrompt(selectedPreset?.prompt ?? '');
  }, [selectedPreset]);

  const canSubmit =
    kind.length > 0 &&
    repoPath.trim().length > 0 &&
    cron.trim().length > 0 &&
    (!promptRequired || (name.trim().length > 0 && prompt.trim().length > 0));

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
      setCron(DEFAULT_CRON);
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
      onClose();
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
    onClose,
  ]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        data-testid="schedule-create-dialog"
        className="max-h-[88vh] gap-0 overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader className="pb-4">
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            A cron-triggered agent run. Pick a template, tell it what to do, choose when it fires.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* ── What it does ─────────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-kind">Template</Label>
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
            <Label htmlFor="schedule-name">
              Name {promptRequired && <span className="text-destructive">*</span>}
            </Label>
            <Input
              id="schedule-name"
              data-testid="schedule-name"
              placeholder={
                promptRequired ? 'e.g. Daily code review' : selectedKind?.displayName || 'Optional'
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Prompt is copied from the preset into schedules.prompt at create time
              (spec §1) — always shown as an editable field, never an invisible
              default (§7.1). Required only when the kind's preset ships no prompt. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-prompt">
              Instructions {promptRequired && <span className="text-destructive">*</span>}
            </Label>
            <Textarea
              id="schedule-prompt"
              data-testid="schedule-prompt"
              placeholder="Describe what the agent should do in each run"
              rows={8}
              className="min-h-[9rem] font-mono text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            {!promptRequired && (
              <p className="text-[10px] text-muted-soft">
                Pre-filled from the {selectedKind?.displayName ?? kind} preset. Editing here only
                changes this schedule — the preset itself is untouched.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repo-path">Repository</Label>
            <RepoPickerField value={repoPath} onChange={setRepoPath} />
          </div>

          {/* ── When it fires ────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 border-t border-glass-edge pt-4">
            <SectionLabel>Select a trigger</SectionLabel>
            <TriggerPicker
              cron={cron}
              onCronChange={setCron}
              timezone={timezone}
              timezoneField={<TimezoneField value={timezone} onChange={setTimezone} />}
            />
          </div>

          {/* ── Options ──────────────────────────────────────────────── */}
          {selectedKind?.configSchema ? (
            <div className="flex flex-col gap-3 border-t border-glass-edge pt-4">
              <SectionLabel>Workflow config</SectionLabel>
              <SchemaConfigForm
                schema={selectedKind.configSchema}
                value={config}
                onChange={setConfig}
              />
            </div>
          ) : null}

          <details className="group border-t border-glass-edge pt-4">
            <summary className="flex w-fit cursor-pointer items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground">
              Advanced
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="schedule-model">Model</Label>
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
                  <Label htmlFor="schedule-timeout">Timeout (minutes)</Label>
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
                    Defaults to 5 minutes. Min 10 s, max 24 h.
                  </p>
                </div>
              )}
            </div>
          </details>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="mt-5 items-center sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
            Enabled
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              data-testid="schedule-submit"
              disabled={!canSubmit || submitting}
              onClick={handleSubmit}
            >
              {submitting ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [prompt, setPrompt] = useState(row.prompt ?? '');
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
    setPrompt(row.prompt ?? '');
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
        prompt: prompt.trim() ? prompt : null,
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
    prompt,
    config,
    kindInfo,
    onSaved,
  ]);

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
        <div className="flex flex-col gap-1.5">
          <Label>Trigger</Label>
          <CronScheduleField
            value={cron}
            onChange={setCron}
            timezone={timezone}
            testIdPrefix={`schedule-edit-cron-${row.id}`}
          />
        </div>
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

      {/* Plain textarea bound to schedules.prompt — the row is self-contained
          (spec §1), so there's no resolution, preview, or "reset to kind
          default" here anymore; this schedule's copy is the only prompt. */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`schedule-edit-prompt-${row.id}`}>Prompt</Label>
        <Textarea
          id={`schedule-edit-prompt-${row.id}`}
          data-testid={`schedule-edit-prompt-${row.id}`}
          rows={8}
          className="font-mono text-sm"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="text-[10px] text-muted-soft">
          Copied from the kind preset at create time — editing here only affects this schedule.
        </p>
      </div>

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

// ─── Import schedule dialog ───────────────────────────────────────────────────

/**
 * Imports a `GET /api/schedules/:id/export` envelope (spec §5/§6.2). `repoPath`
 * is deliberately not part of the envelope — this dialog is the prompt for it,
 * reusing the same repo picker as the create panel.
 */
function ImportScheduleDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleImport = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      await schedulesApi.importSchedule({
        ...parsed,
        repoPath: repoPath.trim(),
      } as ImportScheduleInput);
      setText('');
      setRepoPath('');
      onImported();
    } catch (err) {
      setError((err as Error).message || 'Failed to import schedule');
    } finally {
      setSaving(false);
    }
  }, [text, repoPath, onImported]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="schedule-import-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import schedule JSON</DialogTitle>
          <DialogDescription>
            Paste a schedule export and pick the repository to run it against.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Repository</Label>
            <RepoPickerField value={repoPath} onChange={setRepoPath} />
          </div>
          <Textarea
            data-testid="schedule-import-textarea"
            rows={10}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='{"octomuxSchedule": 1, "kind": "...", ...}'
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            data-testid="schedule-import-submit"
            disabled={!text.trim() || !repoPath.trim() || saving}
            onClick={handleImport}
          >
            {saving ? 'Importing…' : 'Import'}
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
  const [presets, setPresets] = useState<PresetWithSource[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(() => searchParams.get('expand'));
  const [deleteTarget, setDeleteTarget] = useState<ScheduleRow | null>(null);
  const [runsKey, setRunsKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const schedules = data ?? [];

  const kindByName = useMemo(() => new Map(kinds.map((k) => [k.kind, k])), [kinds]);

  useEffect(() => {
    schedulesApi.getScheduleKinds().then((res) => setKinds(res.kinds));
    kindsApi.listKinds().then((res) => setPresets(res.kinds));
  }, []);

  const handleToggle = useCallback(
    async (row: ScheduleRow) => {
      await schedulesApi.updateSchedule(row.id, { enabled: row.enabled !== 1 });
      refresh();
    },
    [refresh],
  );

  const handleExport = useCallback(async (id: string) => {
    try {
      const data = await schedulesApi.exportSchedule(id);
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      showToast('success', 'COPIED', 'Schedule JSON copied to clipboard.');
    } catch (err) {
      showToast('error', 'EXPORT FAILED', (err as Error).message || 'Could not export schedule.');
    }
  }, []);

  const deleteKindInfo = deleteTarget ? (kindByName.get(deleteTarget.kind) ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <PageHeader
        title="Schedules"
        description="Cron-triggered runs — creatable and observable from here."
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="schedule-import-open"
              onClick={() => setImportOpen(true)}
            >
              Import JSON
            </Button>
            <Button size="sm" data-testid="schedule-new" onClick={() => setCreateOpen(true)}>
              New schedule
            </Button>
          </div>
        }
      />

      <ScheduleDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        kinds={kinds}
        presets={presets}
        onCreated={refresh}
      />

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
        <GlassPanel
          level={2}
          className="flex flex-col items-center gap-3 rounded-2xl px-4 py-10 text-center"
        >
          <p className="text-sm text-muted-foreground">No schedules yet.</p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            New schedule
          </Button>
        </GlassPanel>
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
                        data-testid={`schedule-export-${row.id}`}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                        onClick={() => handleExport(row.id)}
                      >
                        Export
                      </button>
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

      <ImportScheduleDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          refresh();
        }}
      />
    </div>
  );
}
