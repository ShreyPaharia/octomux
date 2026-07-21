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
import { Textarea } from '@/components/ui/textarea';
import { FormSelect } from '@/components/ui/form-select';
import { Switch } from '@/components/ui/switch';
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

function parseConfigJson(configJson: string | null): Record<string, unknown> {
  if (!configJson) return {};
  try {
    return JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function ScheduleForm({ kinds, onCreated }: { kinds: ScheduleKindInfo[]; onCreated: () => void }) {
  const [kind, setKind] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [cron, setCron] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedKind = useMemo(() => kinds.find((k) => k.kind === kind) ?? null, [kinds, kind]);

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

  const canSubmit = kind.length > 0 && repoPath.trim().length > 0 && cron.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const payloadConfig =
        selectedKind?.configSchema && Object.keys(config).length > 0 ? config : undefined;

      await schedulesApi.createSchedule({
        kind,
        repoPath: repoPath.trim(),
        cron: cron.trim(),
        enabled,
        ...(payloadConfig ? { config: payloadConfig } : {}),
      });

      setRepoPath('');
      setCron('');
      setEnabled(true);
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
  }, [canSubmit, kind, repoPath, cron, enabled, config, selectedKind, onCreated]);

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
          <Label htmlFor="schedule-repo-path">Repo path</Label>
          <Input
            id="schedule-repo-path"
            data-testid="schedule-repo-path"
            placeholder="/path/to/repo"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-cron">Cron</Label>
          <Input
            id="schedule-cron"
            data-testid="schedule-cron"
            className="font-mono text-sm"
            placeholder="0 7 * * 1-5"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
          />
        </div>
      </div>

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
      </div>
    </GlassPanel>
  );
}

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
  const [prompt, setPrompt] = useState(row.prompt ?? '');
  const [defaultPrompt, setDefaultPrompt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCron(row.cron);
    setEnabled(row.enabled === 1);
    setConfig(parseConfigJson(row.config_json));
    setPrompt(row.prompt ?? '');
  }, [row]);

  useEffect(() => {
    let cancelled = false;
    schedulesApi.getDefaultPrompt(row.kind, row.repo_path).then((res) => {
      if (!cancelled) setDefaultPrompt(res.content);
    });
    return () => {
      cancelled = true;
    };
  }, [row.kind, row.repo_path]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await schedulesApi.updateSchedule(row.id, {
        cron: cron.trim(),
        enabled,
        ...(kindInfo?.configSchema ? { config } : {}),
        prompt: prompt.trim() ? prompt : null,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message || 'Failed to save schedule');
    } finally {
      setSaving(false);
    }
  }, [row.id, cron, enabled, config, prompt, kindInfo, onSaved]);

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

  const handleResetPrompt = useCallback(() => {
    if (defaultPrompt !== null) setPrompt(defaultPrompt);
  }, [defaultPrompt]);

  return (
    <div className="flex flex-col gap-4 border-t border-glass-edge pt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`schedule-edit-cron-${row.id}`}>Cron</Label>
          <Input
            id={`schedule-edit-cron-${row.id}`}
            data-testid={`schedule-edit-cron-${row.id}`}
            className="font-mono text-sm"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
          />
        </div>
        <div className="flex items-end gap-3 pb-1">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={enabled}
              onChange={setEnabled}
              aria-label={`Enable ${row.kind} schedule`}
            />
            Enabled
          </label>
        </div>
      </div>

      {kindInfo?.configSchema ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Workflow config</p>
          <SchemaConfigForm schema={kindInfo.configSchema} value={config} onChange={setConfig} />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">Agent prompt</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid={`schedule-reset-prompt-${row.id}`}
            disabled={defaultPrompt === null}
            onClick={handleResetPrompt}
          >
            Reset to default
          </Button>
        </div>
        <Textarea
          data-testid={`schedule-prompt-${row.id}`}
          className="min-h-48 font-mono text-xs"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={defaultPrompt ?? 'Loading default prompt…'}
        />
        <p className="text-[10px] text-muted-soft">
          Stored in the database. Leave empty to use the shipped SKILL.md default on the next run.
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

function ScheduleDeleteDialog({
  schedule,
  onOpenChange,
  onConfirm,
}: {
  schedule: ScheduleRow | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={schedule !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="confirm-delete-schedule" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete schedule?</DialogTitle>
          <DialogDescription>
            This stops{' '}
            <span className="font-medium text-foreground">
              {schedule?.kind} · {schedule?.repo_path}
            </span>{' '}
            from firing. Past runs are unaffected.
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
          {schedules.map((row) => (
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
                    {row.kind}
                  </button>
                  <span className="truncate text-xs text-muted-foreground">{row.repo_path}</span>
                  <Badge variant="outline" className="font-mono">
                    {row.cron}
                  </Badge>
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
                    kindInfo={kindByName.get(row.kind) ?? null}
                    onSaved={refresh}
                    onRunStarted={() => {
                      setRunsKey((k) => k + 1);
                      refresh();
                    }}
                  />
                )}
              </GlassPanel>
            </li>
          ))}
        </ul>
      )}

      <ScheduleDeleteDialog
        schedule={deleteTarget}
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
