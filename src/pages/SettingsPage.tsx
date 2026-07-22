import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRepoConfigs, useHarnesses } from '../lib/hooks';
import { configApi } from '@/lib/api/configApi';
import type { RepoConfig, HookRegistryEntry } from '@/lib/api/configApi';
import {
  TERMINAL_CACHE_DEFAULT,
  TERMINAL_CACHE_MAX,
  TERMINAL_CACHE_MIN,
  getTerminalCacheSize,
  setTerminalCacheSize,
} from '@/lib/terminal-cache-settings';
import { ReviewsSection } from '@/components/settings/LearningsPanel';
import { scheduleSkillsApi, type ScheduleSkill } from '@/lib/api/schedulesApi';
import { showToast } from '@/components/CustomToast';
import { repoName } from '@/lib/utils';
import { AddChip } from '@/components/layout/add-chip';
import { SectionCard } from '@/components/layout/section-card';
import { SettingRow } from '@/components/layout/setting-row';
import { SettingsLayout, type SettingsScrollSection } from '@/components/layout/settings-layout';
import { DataSection } from '@/components/data-section';
import { FormDialogActions } from '@/components/crud-dialog';
import { GlassPanel } from '@/components/ui/glass-panel';
import { GlassButton } from '@/components/ui/glass-button';
import { GlassInput } from '@/components/ui/glass-input';
import { FormSelect } from '@/components/ui/form-select';
import { Switch } from '@/components/ui/switch';
import { ROW_DIVIDER } from '@/lib/design-tokens';
import { getNotificationsEnabled, setNotificationsEnabled } from '@/lib/notification-settings';

function RepoRow({ config, onEditClick }: { config: RepoConfig; onEditClick: () => void }) {
  const [showMenu, setShowMenu] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="group relative flex items-center justify-between py-3" style={ROW_DIVIDER}>
      <div>
        <span className="text-sm font-bold">{repoName(config.repo_path)}</span>
        <span className="ml-2 text-xs text-[#8a8a8a]">{config.repo_path}</span>
      </div>
      <div className="flex items-center gap-3">
        {config.base_branch && (
          <span className="bg-[#1a1a2e] px-2 py-0.5 text-xs text-[#8a8aff]">
            {config.base_branch}
          </span>
        )}
        <button
          type="button"
          aria-label={`Actions for ${repoName(config.repo_path)}`}
          data-testid={`repo-overflow-${repoName(config.repo_path)}`}
          className="focus-ring text-[#8a8a8a] opacity-0 transition-opacity group-hover:opacity-100 hover:text-white focus-visible:opacity-100"
          onClick={() => setShowMenu((v) => !v)}
        >
          ⋯
        </button>
        {showMenu && (
          <GlassPanel
            level={3}
            specular
            className="absolute right-0 top-10 z-10 min-w-32 py-1 text-xs"
          >
            <button
              type="button"
              className="focus-ring block w-full px-3 py-1.5 text-left text-white hover:bg-glass-l1"
              onClick={() => {
                setShowMenu(false);
                onEditClick();
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="focus-ring block w-full px-3 py-1.5 text-left text-red-400 hover:bg-red-400/10"
              onClick={() => {
                setShowMenu(false);
                navigate(`/?repo=${encodeURIComponent(config.repo_path)}`);
                showToast(
                  'info',
                  'REMOVE REPO',
                  'Open the task for this repo to archive or remove it.',
                );
              }}
            >
              Remove
            </button>
          </GlassPanel>
        )}
      </div>
    </div>
  );
}

function RepoConfigsSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const { configs, loading, error, refresh } = useRepoConfigs();
  const navigate = useNavigate();
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const startEdit = (config: RepoConfig) => {
    setEditingPath(config.repo_path);
    setEditForm({
      base_branch: config.base_branch ?? '',
      test_command: config.test_command,
      format_command: config.format_command,
      lint_command: config.lint_command,
    });
  };

  const handleSave = async () => {
    if (!editingPath || saving) return;
    setSaving(true);
    try {
      await configApi.updateRepoConfig(editingPath, editForm);
      showToast('success', 'SAVED', 'Repository config updated');
      setEditingPath(null);
      refresh();
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const editing = configs.find((c) => c.repo_path === editingPath) ?? null;

  return (
    <SectionCard
      id="repositories"
      title="Repositories"
      count={!loading && !error ? configs.length : undefined}
      scrollRef={scrollRef}
      trailing={
        <AddChip
          label="+ Add repo"
          onClick={() => {
            navigate('/');
            requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('focus-composer')));
          }}
        />
      }
    >
      <DataSection
        loading={loading}
        error={error}
        onRetry={refresh}
        isEmpty={configs.length === 0}
        skeletonRows={2}
        empty={
          <div
            data-testid="repos-empty"
            className="flex flex-col items-center gap-2 py-10 text-center"
          >
            <button
              type="button"
              data-testid="repos-add-first"
              onClick={() => {
                navigate('/');
                requestAnimationFrame(() =>
                  window.dispatchEvent(new CustomEvent('focus-composer')),
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#3B82F666] bg-[#3B82F61F] px-3 py-2 text-[12px] font-semibold text-[#60a5fa] hover:bg-[#3B82F633]"
            >
              + Add your first repo
            </button>
            <p className="text-[11px] text-[#8a8a8a]">
              Repositories appear here automatically when you create tasks.
            </p>
          </div>
        }
      >
        {configs.map((config) => (
          <RepoRow key={config.repo_path} config={config} onEditClick={() => startEdit(config)} />
        ))}
      </DataSection>

      {editing && (
        <div className="mt-3 space-y-2 border border-glass-edge bg-glass-l1 p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#8a8a8a]">
            Edit {repoName(editing.repo_path)}
          </div>
          {(['base_branch', 'test_command', 'format_command', 'lint_command'] as const).map(
            (field) => (
              <div key={field} className="flex items-center gap-2">
                <label className="w-32 text-xs text-[#b5b5bd]">{field.replace(/_/g, ' ')}</label>
                <GlassInput
                  type="text"
                  fieldSize="sm"
                  className="flex-1"
                  value={editForm[field] ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, [field]: e.target.value }))}
                />
              </div>
            ),
          )}
          <FormDialogActions
            className="flex justify-end gap-2 pt-1"
            onCancel={() => setEditingPath(null)}
            onSubmit={handleSave}
            submitLabel="Save"
            submittingLabel="Saving..."
            submitting={saving}
          />
        </div>
      )}
    </SectionCard>
  );
}

function EditorSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [editor, setEditor] = useState<string>('nvim');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    configApi
      .getSettings()
      .then((s) => {
        if (!cancelled) setEditor(s.editor);
      })
      .catch((err) => {
        if (!cancelled) showToast('error', 'ERROR', err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = async (value: string) => {
    const prev = editor;
    setEditor(value);
    try {
      await configApi.updateSettings({ editor: value as 'nvim' | 'vscode' | 'cursor' });
      showToast('success', 'EDITOR', `Editor set to ${value}`);
    } catch (err) {
      setEditor(prev);
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to update editor');
    }
  };

  if (loading) return null;

  return (
    <SectionCard id="editor" title="Editor" scrollRef={scrollRef}>
      <SettingRow
        label="Editor"
        description="Editor to open when clicking the Editor button on tasks"
        lastRow
      >
        <FormSelect value={editor} onChange={(e) => handleChange(e.target.value)}>
          <option value="nvim">Neovim</option>
          <option value="vscode">VS Code</option>
          <option value="cursor">Cursor</option>
        </FormSelect>
      </SettingRow>
    </SectionCard>
  );
}

function ClaudeLaunchFlagsSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [dangerouslySkip, setDangerouslySkip] = useState(false);
  const [savedFlags, setSavedFlags] = useState('');
  const [flagsBuffer, setFlagsBuffer] = useState('');
  const [envOverride, setEnvOverride] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    configApi
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setDangerouslySkip(s.dangerouslySkipPermissions);
        setSavedFlags(s.claudeFlags);
        setFlagsBuffer(s.claudeFlags);
        setEnvOverride(s.envOverrides?.claudeFlags ?? null);
      })
      .catch((err) => {
        if (!cancelled) showToast('error', 'ERROR', err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (value: boolean) => {
    const prev = dangerouslySkip;
    setDangerouslySkip(value);
    try {
      await configApi.updateSettings({ dangerouslySkipPermissions: value });
      showToast(
        'success',
        'LAUNCH FLAGS',
        value
          ? '--dangerously-skip-permissions enabled'
          : '--dangerously-skip-permissions disabled',
      );
    } catch (err) {
      setDangerouslySkip(prev);
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const isDirty = flagsBuffer !== savedFlags;
  const saveFlags = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    try {
      const result = await configApi.updateSettings({ claudeFlags: flagsBuffer });
      setSavedFlags(result.claudeFlags);
      setFlagsBuffer(result.claudeFlags);
      showToast('success', 'LAUNCH FLAGS', 'Advanced flags saved');
    } catch (err) {
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to save flags');
    } finally {
      setSaving(false);
    }
  }, [flagsBuffer, isDirty, saving]);

  if (loading) return null;

  return (
    <SectionCard id="agent-launch" title="Agent launch" scrollRef={scrollRef}>
      {envOverride !== null && (
        <div className="mb-3 border border-[#FFB800]/40 bg-[#FFB800]/5 px-3 py-2 text-xs text-[#FFB800]">
          Overridden by OCTOMUX_CLAUDE_FLAGS env var:{' '}
          <span className="font-mono text-[#FFB800]">{envOverride}</span>
        </div>
      )}

      <SettingRow
        label="--dangerously-skip-permissions"
        description="Also adds cursor-agent --force for Cursor harness tasks — same permissive stance as Claude. Cursor CLI calls this behavior --force (--yolo is an alias)."
      >
        <Switch checked={dangerouslySkip} onChange={handleToggle} />
      </SettingRow>

      {dangerouslySkip && (
        <div className="mb-3 mt-3 border border-red-400/40 bg-red-400/5 px-3 py-2 text-xs text-red-400">
          ⚠ DANGER: agents will execute shell commands without confirmation. Only enable in trusted
          environments.
        </div>
      )}

      <div className="py-3" style={ROW_DIVIDER}>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <span className="text-sm">Advanced flags</span>
            <p className="text-xs text-[#b5b5bd]">
              Extra flags appended to the claude launch command
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isDirty && <span className="text-xs text-[#FFB800]">unsaved</span>}
            <GlassButton size="inline" onClick={saveFlags} disabled={!isDirty || saving}>
              {saving ? 'Saving...' : 'Save'}
            </GlassButton>
          </div>
        </div>
        <GlassInput
          type="text"
          fieldSize="md"
          className="text-xs"
          value={flagsBuffer}
          onChange={(e) => setFlagsBuffer(e.target.value)}
          placeholder="--model opus --verbose"
          spellCheck={false}
        />
      </div>
    </SectionCard>
  );
}

const CURSOR_DEFAULT_MODEL = 'composer-2.5';

function buildCursorHarnessBlob(opts: {
  force: boolean;
  model: string;
  flags: string;
}): Record<string, unknown> {
  const cursor: Record<string, unknown> = {};
  if (opts.force) cursor.force = true;
  const model = opts.model.trim();
  if (model) cursor.model = model;
  const flags = opts.flags.trim();
  if (flags) cursor.flags = flags;
  return cursor;
}

function CodingAgentSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const { harnesses, loading: harnessesLoading } = useHarnesses();
  const [defaultHarnessId, setDefaultHarnessIdState] = useState<string>('claude-code');
  const [dangerousLaunchGlobal, setDangerousLaunchGlobal] = useState(false);
  const [cursorForce, setCursorForce] = useState(false);
  const [cursorModelSaved, setCursorModelSaved] = useState(CURSOR_DEFAULT_MODEL);
  const [cursorModelBuffer, setCursorModelBuffer] = useState(CURSOR_DEFAULT_MODEL);
  const [cursorFlagsSaved, setCursorFlagsSaved] = useState('');
  const [cursorFlagsBuffer, setCursorFlagsBuffer] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingFlags, setSavingFlags] = useState(false);
  const [savingModel, setSavingModel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    configApi
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setDefaultHarnessIdState(s.defaultHarnessId ?? 'claude-code');
        setDangerousLaunchGlobal(Boolean(s.dangerouslySkipPermissions));
        const sub = (s.harnesses?.cursor ?? {}) as {
          flags?: string;
          force?: boolean;
          model?: string;
        };
        setCursorForce(Boolean(sub.force));
        const model = (sub.model?.trim() || CURSOR_DEFAULT_MODEL) as string;
        setCursorModelSaved(model);
        setCursorModelBuffer(model);
        setCursorFlagsSaved(sub.flags ?? '');
        setCursorFlagsBuffer(sub.flags ?? '');
      })
      .catch((err) => {
        if (!cancelled) showToast('error', 'ERROR', err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDefaultChange = async (value: string) => {
    const prev = defaultHarnessId;
    setDefaultHarnessIdState(value);
    try {
      await configApi.updateSettings({ defaultHarnessId: value });
      showToast('success', 'CODING AGENT', `Default set to ${value}`);
    } catch (err) {
      setDefaultHarnessIdState(prev);
      showToast(
        'error',
        'ERROR',
        err instanceof Error ? err.message : 'Failed to update default agent',
      );
    }
  };

  const handleCursorModelSave = useCallback(async () => {
    const next = cursorModelBuffer.trim();
    if (!next || next === cursorModelSaved || savingModel) return;
    setSavingModel(true);
    const prev = cursorModelSaved;
    setCursorModelSaved(next);
    try {
      await configApi.updateSettings({
        harnesses: {
          cursor: buildCursorHarnessBlob({
            force: cursorForce,
            model: next,
            flags: cursorFlagsSaved,
          }),
        },
      });
      showToast('success', 'CURSOR', `Default model set to ${next}`);
    } catch (err) {
      setCursorModelSaved(prev);
      setCursorModelBuffer(prev);
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to save model');
    } finally {
      setSavingModel(false);
    }
  }, [cursorModelBuffer, cursorModelSaved, cursorForce, cursorFlagsSaved, savingModel]);

  const handleCursorForceToggle = async (next: boolean) => {
    const prev = cursorForce;
    setCursorForce(next);
    try {
      await configApi.updateSettings({
        harnesses: {
          cursor: buildCursorHarnessBlob({
            force: next,
            model: cursorModelSaved,
            flags: cursorFlagsSaved,
          }),
        },
      });
      showToast(
        'success',
        'CURSOR',
        next ? '--force enabled (skip permissions)' : '--force disabled',
      );
    } catch (err) {
      setCursorForce(prev);
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const cursorFlagsDirty = cursorFlagsBuffer !== cursorFlagsSaved;
  const saveCursorFlags = useCallback(async () => {
    if (!cursorFlagsDirty || savingFlags) return;
    setSavingFlags(true);
    try {
      const result = await configApi.updateSettings({
        harnesses: {
          cursor: buildCursorHarnessBlob({
            force: cursorForce,
            model: cursorModelSaved,
            flags: cursorFlagsBuffer.trim(),
          }),
        },
      });
      const sub = (result.harnesses?.cursor ?? {}) as { flags?: string; model?: string };
      setCursorFlagsSaved(sub.flags ?? '');
      setCursorFlagsBuffer(sub.flags ?? '');
      if (sub.model) {
        setCursorModelSaved(sub.model);
        setCursorModelBuffer(sub.model);
      }
      showToast('success', 'CURSOR', 'Cursor flags saved');
    } catch (err) {
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to save flags');
    } finally {
      setSavingFlags(false);
    }
  }, [cursorFlagsDirty, savingFlags, cursorFlagsBuffer, cursorForce, cursorModelSaved]);

  const cursorModelDirty = cursorModelBuffer.trim() !== cursorModelSaved;

  if (loading || harnessesLoading) return null;

  return (
    <SectionCard id="coding-agent" title="Coding agent" scrollRef={scrollRef}>
      <SettingRow
        label="Default coding agent"
        description="New tasks and chats use this coding agent unless overridden in the composer"
      >
        <FormSelect
          data-testid="default-harness-select"
          value={defaultHarnessId}
          onChange={(e) => handleDefaultChange(e.target.value)}
        >
          {harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.displayName}
            </option>
          ))}
        </FormSelect>
      </SettingRow>

      <div className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-wider text-[#8a8a8a]">
        Cursor
      </div>

      <div className="py-3" style={ROW_DIVIDER}>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <span className="text-sm">Default model</span>
            <p className="text-xs text-[#b5b5bd]">
              Passed as <span className="font-mono">--model</span> on each cursor-agent launch. Run{' '}
              <span className="font-mono">cursor-agent --list-models</span> for ids.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {cursorModelDirty && <span className="text-xs text-[#FFB800]">unsaved</span>}
            <GlassButton
              type="button"
              size="inline"
              onClick={handleCursorModelSave}
              disabled={!cursorModelDirty || savingModel}
            >
              {savingModel ? 'Saving...' : 'Save'}
            </GlassButton>
          </div>
        </div>
        <GlassInput
          type="text"
          data-testid="cursor-model-input"
          fieldSize="md"
          className="text-xs"
          value={cursorModelBuffer}
          onChange={(e) => setCursorModelBuffer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCursorModelSave();
          }}
          placeholder={CURSOR_DEFAULT_MODEL}
          spellCheck={false}
        />
      </div>

      <SettingRow
        label="--force (skip permissions)"
        description="Adds --force only from this switch. The Agent launch section’s --dangerously-skip-permissions toggle also implies --force for cursor-agent (--yolo is a CLI alias), even when this is off."
      >
        <Switch checked={cursorForce} onChange={handleCursorForceToggle} />
      </SettingRow>

      {dangerousLaunchGlobal && !cursorForce && (
        <div className="mb-2 px-1 text-xs text-[#FFB800]">
          Agent launch ▸ --dangerously-skip-permissions is on, so Cursor still runs with{' '}
          <span className="font-mono">--force</span> even when this switch is off.
        </div>
      )}

      {(cursorForce || dangerousLaunchGlobal) && (
        <div className="mb-3 mt-3 border border-red-400/40 bg-red-400/5 px-3 py-2 text-xs text-red-400">
          ⚠ DANGER: Cursor will execute shell commands without confirmation. Only enable in trusted
          environments.
        </div>
      )}

      <div className="py-3" style={ROW_DIVIDER}>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <span className="text-sm">Advanced flags</span>
            <p className="text-xs text-[#b5b5bd]">
              Extra flags appended after --model (e.g. --print). Octomux also passes --workspace and
              mirrors Settings → Agents into .cursor/rules.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {cursorFlagsDirty && <span className="text-xs text-[#FFB800]">unsaved</span>}
            <GlassButton
              size="inline"
              onClick={saveCursorFlags}
              disabled={!cursorFlagsDirty || savingFlags}
            >
              {savingFlags ? 'Saving...' : 'Save'}
            </GlassButton>
          </div>
        </div>
        <GlassInput
          type="text"
          data-testid="cursor-flags-input"
          fieldSize="md"
          className="text-xs"
          value={cursorFlagsBuffer}
          onChange={(e) => setCursorFlagsBuffer(e.target.value)}
          placeholder="--print"
          spellCheck={false}
        />
      </div>
    </SectionCard>
  );
}

function HooksSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [hooks, setHooks] = useState<HookRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    configApi
      .getHooksRegistry()
      .then((r) => setHooks(r.hooks))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = useCallback(async (entry: HookRegistryEntry, next: boolean) => {
    // Optimistic update
    setHooks((prev) =>
      prev.map((h) =>
        h.scope === entry.scope && h.key === entry.key ? { ...h, enabled: next } : h,
      ),
    );
    try {
      await configApi.updateHookEnabled(entry.scope, entry.key, next);
    } catch (err) {
      // Revert
      setHooks((prev) =>
        prev.map((h) =>
          h.scope === entry.scope && h.key === entry.key ? { ...h, enabled: !next } : h,
        ),
      );
      showToast('error', 'HOOKS', (err as Error).message);
    }
  }, []);

  const builtins = hooks.filter((h) => h.scope === 'builtin');
  const globals = hooks.filter((h) => h.scope === 'global');
  const repos = hooks.filter((h) => h.scope !== 'builtin' && h.scope !== 'global');

  function HookGroup({
    title,
    entries,
    emptyMsg,
  }: {
    title: string;
    entries: HookRegistryEntry[];
    emptyMsg: string;
  }) {
    return (
      <div className="mb-4">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#8a8a8a]">
          {title}
        </div>
        {entries.length === 0 ? (
          <div className="py-3 text-xs text-[#8a8a8a]">{emptyMsg}</div>
        ) : (
          <div>
            {entries.map((entry, i) => (
              <div key={`${entry.scope}::${entry.key}`}>
                <SettingRow
                  label={entry.key}
                  description={
                    entry.description ?? (entry.script_path ? entry.script_path : undefined)
                  }
                  lastRow={i === entries.length - 1}
                >
                  <Switch checked={entry.enabled} onChange={(v) => handleToggle(entry, v)} />
                </SettingRow>
                {entry.requires_env && (
                  <div className="mb-1 border border-[#FFB800]/40 bg-[#FFB800]/5 px-3 py-1.5 text-xs text-[#FFB800]">
                    Set <span className="font-mono">{entry.requires_env}</span> to enable Haiku
                    summaries.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <SectionCard
      id="hooks"
      title="Hooks"
      count={!loading && !error ? hooks.length : undefined}
      scrollRef={scrollRef}
    >
      <DataSection loading={loading} error={error} onRetry={load} isEmpty={false} skeletonRows={2}>
        <HookGroup title="Built-in" entries={builtins} emptyMsg="No built-in hooks." />
        <HookGroup title="Global" entries={globals} emptyMsg="No global hooks installed." />
        <HookGroup title="Repo" entries={repos} emptyMsg="No repo hooks from active tasks." />
      </DataSection>
    </SectionCard>
  );
}

function GeneralSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [notifications, setNotifications] = useState(getNotificationsEnabled);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('octomux-sidebar-collapsed') === 'true',
  );
  return (
    <SectionCard id="general" title="General" scrollRef={scrollRef}>
      <SettingRow label="Notifications" description="Show toast notifications for task events">
        <Switch
          checked={notifications}
          onChange={(v) => {
            setNotifications(v);
            setNotificationsEnabled(v);
          }}
        />
      </SettingRow>
      <SettingRow label="Sidebar collapsed by default" lastRow>
        <Switch
          checked={sidebarCollapsed}
          onChange={(v) => {
            setSidebarCollapsed(v);
            localStorage.setItem('octomux-sidebar-collapsed', String(v));
          }}
        />
      </SettingRow>
    </SectionCard>
  );
}

function AdvancedSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [cacheSize, setCacheSize] = useState<number>(() => getTerminalCacheSize());
  const [buffer, setBuffer] = useState<string>(() => String(getTerminalCacheSize()));

  const handleCommit = useCallback(() => {
    const parsed = Number.parseInt(buffer, 10);
    if (!Number.isFinite(parsed)) {
      setBuffer(String(cacheSize));
      return;
    }
    const next = setTerminalCacheSize(parsed);
    setCacheSize(next);
    setBuffer(String(next));
    showToast('success', 'ADVANCED', `Terminal cache size set to ${next}`);
  }, [buffer, cacheSize]);

  return (
    <SectionCard id="advanced" title="Advanced" scrollRef={scrollRef}>
      <SettingRow
        label="Terminal cache size"
        description={`Number of agent terminals kept mounted (LRU). Switching to a cached tab avoids xterm + WebSocket rebuild. Min ${TERMINAL_CACHE_MIN}, max ${TERMINAL_CACHE_MAX}, default ${TERMINAL_CACHE_DEFAULT}.`}
        lastRow
      >
        <div className="flex items-center gap-2">
          <GlassInput
            type="number"
            fieldSize="narrow"
            className="focus-ring"
            min={TERMINAL_CACHE_MIN}
            max={TERMINAL_CACHE_MAX}
            value={buffer}
            onChange={(e) => setBuffer(e.target.value)}
            onBlur={handleCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            data-testid="terminal-cache-size-input"
          />
        </div>
      </SettingRow>
    </SectionCard>
  );
}

function ScheduleSkillRow({ skill, onChanged }: { skill: ScheduleSkill; onChanged: () => void }) {
  const [content, setContent] = useState(skill.content);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setContent(skill.content);
  }, [skill.content]);

  const dirty = content !== skill.content;

  const handleSave = useCallback(async () => {
    setBusy(true);
    try {
      await scheduleSkillsApi.updateScheduleSkill(skill.kind, content);
      showToast('success', 'SAVED', `${skill.kind} skill updated.`);
      onChanged();
    } catch (err) {
      showToast('error', 'SAVE FAILED', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [skill.kind, content, onChanged]);

  const handleReset = useCallback(async () => {
    setBusy(true);
    try {
      await scheduleSkillsApi.resetScheduleSkill(skill.kind);
      showToast('info', 'RESET', `${skill.kind} skill reset to shipped default.`);
      onChanged();
    } catch (err) {
      showToast('error', 'RESET FAILED', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [skill.kind, onChanged]);

  return (
    <details className="group py-3" style={ROW_DIVIDER}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
        {skill.kind}
        {dirty && <span className="text-[10px] text-[#8a8aff]">unsaved</span>}
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <textarea
          data-testid={`schedule-skill-${skill.kind}`}
          className="focus-ring min-h-48 w-full rounded-lg border border-glass-edge bg-glass-l1 p-2 font-mono text-xs"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex gap-2">
          <GlassButton
            variant="primary"
            size="inline"
            data-testid={`schedule-skill-save-${skill.kind}`}
            disabled={busy || !content.trim() || !dirty}
            onClick={handleSave}
          >
            {busy ? 'Saving…' : 'Save'}
          </GlassButton>
          <GlassButton
            variant="cancel"
            size="inline"
            data-testid={`schedule-skill-reset-${skill.kind}`}
            disabled={busy}
            onClick={handleReset}
          >
            Reset to default
          </GlassButton>
        </div>
      </div>
    </details>
  );
}

function ScheduleSkillsSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [skills, setSkills] = useState<ScheduleSkill[] | null>(null);

  const load = useCallback(() => {
    scheduleSkillsApi.listScheduleSkills().then(setSkills);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SectionCard
      id="schedule-skills"
      title="Schedule skills"
      help="Prompt bodies used by cron workflows — the DB is the source of truth."
      scrollRef={scrollRef}
    >
      {skills === null ? (
        <p
          className="py-6 text-center text-sm text-[#8a8a8a]"
          data-testid="schedule-skills-loading"
        >
          Loading…
        </p>
      ) : (
        <div data-testid="schedule-skills-list">
          {skills.map((skill) => (
            <ScheduleSkillRow key={skill.kind} skill={skill} onChanged={load} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export default function SettingsPage() {
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activeSection, setActiveSection] = useState<SettingsScrollSection>('general');

  const setRef = useCallback(
    (id: SettingsScrollSection) => (el: HTMLElement | null) => {
      sectionRefs.current[id] = el;
    },
    [],
  );

  const scrollTo = useCallback((id: SettingsScrollSection) => {
    setActiveSection(id);
    const el = sectionRefs.current[id];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  return (
    <SettingsLayout
      title="Settings"
      description="Workspace preferences · synced to ~/.octomux/config.json"
      activeScrollSection={activeSection}
      onScrollTo={scrollTo}
    >
      <GeneralSection scrollRef={setRef('general')} />
      <HooksSection scrollRef={setRef('hooks')} />
      <RepoConfigsSection scrollRef={setRef('repositories')} />
      <ReviewsSection scrollRef={setRef('reviews')} />
      <EditorSection scrollRef={setRef('editor')} />
      <CodingAgentSection scrollRef={setRef('coding-agent')} />
      <ClaudeLaunchFlagsSection scrollRef={setRef('agent-launch')} />
      <ScheduleSkillsSection scrollRef={setRef('schedule-skills')} />
      <AdvancedSection scrollRef={setRef('advanced')} />
    </SettingsLayout>
  );
}
