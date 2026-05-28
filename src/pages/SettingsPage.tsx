import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSkills, useRepoConfigs, useAgents, useHarnesses } from '../lib/hooks';
import { api } from '@/lib/api';
import type { RepoConfig, HookRegistryEntry } from '@/lib/api';
import {
  TERMINAL_CACHE_DEFAULT,
  TERMINAL_CACHE_MAX,
  TERMINAL_CACHE_MIN,
  getTerminalCacheSize,
  setTerminalCacheSize,
} from '@/lib/terminal-cache-settings';
import { ReviewsSection } from '@/components/settings/LearningsPanel';
import { showToast } from '@/components/CustomToast';
import { repoName } from '@/lib/utils';
import { AddChip } from '@/components/layout/add-chip';
import { SectionCard } from '@/components/layout/section-card';
import { SettingRow } from '@/components/layout/setting-row';
import { SettingsLayout, type SettingsScrollSection } from '@/components/layout/settings-layout';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Switch } from '@/components/ui/switch';
import { ROW_DIVIDER } from '@/lib/design-tokens';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

function AgentsSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const { agents, loading, error, refresh } = useAgents();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const content = `---\nname: ${newName.trim()}\ndescription: \n---\n`;
      await api.createAgent({ name: newName.trim(), content });
      showToast('success', 'AGENT CREATED', `Agent "${newName.trim()}" created`);
      setShowCreate(false);
      setNewName('');
      navigate(`/agents/${encodeURIComponent(newName.trim())}`);
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [newName, navigate]);

  return (
    <SectionCard
      id="agents"
      title="Agents"
      count={!loading && !error ? agents.length : undefined}
      scrollRef={scrollRef}
      trailing={<AddChip label="+ New agent" onClick={() => setShowCreate(true)} />}
    >
      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse bg-glass-l1 border border-glass-edge" />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 border border-red-400/30 bg-red-400/5 px-4 py-3">
          <span className="text-sm text-red-400">{error}</span>
          <button
            className="focus-ring text-xs text-[#3B82F6] hover:text-[#60a5fa] active:text-[#93c5fd]"
            onClick={refresh}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && agents.length === 0 && (
        <div className="py-8 text-center text-sm text-[#8a8a8a]">No agents found.</div>
      )}

      {!loading && !error && agents.length > 0 && (
        <div>
          {agents.map((agent, i) => (
            <div
              key={agent.name}
              className="flex items-center justify-between py-3 cursor-pointer hover:bg-glass-l1 px-1 -mx-1"
              style={i === agents.length - 1 ? undefined : ROW_DIVIDER}
              onClick={() => navigate(`/agents/${encodeURIComponent(agent.name)}`)}
            >
              <div>
                <span className="text-sm font-mono">{agent.name}</span>
                {agent.description && <p className="text-xs text-[#b5b5bd]">{agent.description}</p>}
              </div>
              <span className={`text-xs ${agent.isCustom ? 'text-[#FFB800]' : 'text-[#8a8a8a]'}`}>
                {agent.isCustom ? 'Custom' : 'Default'}
              </span>
            </div>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold">Create Agent</DialogTitle>
          </DialogHeader>
          <input
            type="text"
            placeholder="Agent name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              className="focus-ring px-3 py-1.5 text-xs text-[#b5b5bd] hover:text-white"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </button>
            <button
              className="focus-ring bg-[#3B82F6] px-3 py-1.5 text-xs text-white hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:opacity-40"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

function SkillsSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const { skills, loading, error, refresh } = useSkills();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const content = `---\nname: ${newName.trim()}\ndescription: \n---\n`;
      await api.createSkill({ name: newName.trim(), content });
      showToast('success', 'SKILL CREATED', `Skill "${newName.trim()}" created`);
      setShowCreate(false);
      setNewName('');
      navigate(`/skills/${encodeURIComponent(newName.trim())}`);
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [newName, navigate]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteSkill(deleteTarget);
      showToast('success', 'SKILL DELETED', `Skill "${deleteTarget}" deleted`);
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, refresh]);

  return (
    <SectionCard
      id="skills"
      title="Skills"
      count={!loading && !error ? skills.length : undefined}
      scrollRef={scrollRef}
      trailing={<AddChip label="+ New skill" onClick={() => setShowCreate(true)} />}
    >
      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse bg-glass-l1 border border-glass-edge" />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 border border-red-400/30 bg-red-400/5 px-4 py-3">
          <span className="text-sm text-red-400">{error}</span>
          <button
            className="focus-ring text-xs text-[#3B82F6] hover:text-[#60a5fa] active:text-[#93c5fd]"
            onClick={refresh}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && skills.length === 0 && (
        <div className="py-8 text-center text-sm text-[#8a8a8a]">
          No skills installed.{' '}
          <button
            className="focus-ring text-[#3B82F6] hover:text-[#60a5fa] active:text-[#93c5fd]"
            onClick={() => setShowCreate(true)}
          >
            Create your first skill
          </button>
        </div>
      )}

      {!loading && !error && skills.length > 0 && (
        <div>
          {skills.map((skill, i) => (
            <div
              key={skill.name}
              className="group flex items-center justify-between py-3 cursor-pointer hover:bg-glass-l1 px-1 -mx-1"
              style={i === skills.length - 1 ? undefined : ROW_DIVIDER}
              onClick={() => navigate(`/skills/${encodeURIComponent(skill.name)}`)}
            >
              <div>
                <span className="text-sm font-mono">{skill.name}</span>
                {skill.description && <p className="text-xs text-[#b5b5bd]">{skill.description}</p>}
              </div>
              <button
                className="focus-ring text-xs text-[#8a8a8a] opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400 focus-visible:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(skill.name);
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold">Create Skill</DialogTitle>
          </DialogHeader>
          <input
            type="text"
            placeholder="Skill name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              className="focus-ring px-3 py-1.5 text-xs text-[#b5b5bd] hover:text-white"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </button>
            <button
              className="focus-ring bg-[#3B82F6] px-3 py-1.5 text-xs text-white hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:opacity-40"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold">Delete Skill</DialogTitle>
            <DialogDescription className="text-xs text-[#b5b5bd]">
              Are you sure you want to delete{' '}
              <span className="font-mono text-white">{deleteTarget}</span>? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <button
              className="focus-ring px-3 py-1.5 text-xs text-[#b5b5bd] hover:text-white"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </button>
            <button
              className="focus-ring bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700 active:bg-red-800 disabled:opacity-40"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

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
      await api.updateRepoConfig(editingPath, editForm);
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
      {loading && (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse bg-glass-l1 border border-glass-edge" />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 border border-red-400/30 bg-red-400/5 px-4 py-3">
          <span className="text-sm text-red-400">{error}</span>
          <button
            className="focus-ring text-xs text-[#3B82F6] hover:text-[#60a5fa] active:text-[#93c5fd]"
            onClick={refresh}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && configs.length === 0 && (
        <div
          data-testid="repos-empty"
          className="flex flex-col items-center gap-2 py-10 text-center"
        >
          <button
            type="button"
            data-testid="repos-add-first"
            onClick={() => {
              navigate('/');
              requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('focus-composer')));
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#3B82F666] bg-[#3B82F61F] px-3 py-2 text-[12px] font-semibold text-[#60a5fa] hover:bg-[#3B82F633]"
          >
            + Add your first repo
          </button>
          <p className="text-[11px] text-[#8a8a8a]">
            Repositories appear here automatically when you create tasks.
          </p>
        </div>
      )}

      {!loading &&
        !error &&
        configs.map((config) => (
          <RepoRow key={config.repo_path} config={config} onEditClick={() => startEdit(config)} />
        ))}

      {editing && (
        <div className="mt-3 space-y-2 border border-glass-edge bg-glass-l1 p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#8a8a8a]">
            Edit {repoName(editing.repo_path)}
          </div>
          {(['base_branch', 'test_command', 'format_command', 'lint_command'] as const).map(
            (field) => (
              <div key={field} className="flex items-center gap-2">
                <label className="w-32 text-xs text-[#b5b5bd]">{field.replace(/_/g, ' ')}</label>
                <input
                  type="text"
                  value={editForm[field] ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, [field]: e.target.value }))}
                  className="flex-1 border border-glass-edge bg-[#0B0C0F] px-2 py-1 font-mono text-xs text-white outline-none focus:border-[#3B82F6]"
                />
              </div>
            ),
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setEditingPath(null)}
              className="focus-ring px-3 py-1 text-xs text-[#b5b5bd] hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="focus-ring bg-[#3B82F6] px-3 py-1 text-xs text-white hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:opacity-40"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
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
    api
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
      await api.updateSettings({ editor: value as 'nvim' | 'vscode' | 'cursor' });
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
        <select
          value={editor}
          onChange={(e) => handleChange(e.target.value)}
          className="focus-ring bg-[#0B0C0F] border border-glass-edge px-3 py-1 text-xs text-white outline-none focus:border-[#3B82F6]"
        >
          <option value="nvim">Neovim</option>
          <option value="vscode">VS Code</option>
          <option value="cursor">Cursor</option>
        </select>
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
    api
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
      await api.updateSettings({ dangerouslySkipPermissions: value });
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
      const result = await api.updateSettings({ claudeFlags: flagsBuffer });
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
            <button
              onClick={saveFlags}
              disabled={!isDirty || saving}
              className="focus-ring bg-[#3B82F6] px-3 py-1 text-xs text-white hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:opacity-40"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        <input
          type="text"
          value={flagsBuffer}
          onChange={(e) => setFlagsBuffer(e.target.value)}
          placeholder="--model opus --verbose"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#3B82F6]"
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
    api
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
      await api.updateSettings({ defaultHarnessId: value });
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
      await api.updateSettings({
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
      await api.updateSettings({
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
      const result = await api.updateSettings({
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
        <select
          data-testid="default-harness-select"
          value={defaultHarnessId}
          onChange={(e) => handleDefaultChange(e.target.value)}
          className="focus-ring bg-[#0B0C0F] border border-glass-edge px-3 py-1 text-xs text-white outline-none focus:border-[#3B82F6]"
        >
          {harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.displayName}
            </option>
          ))}
        </select>
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
            <button
              type="button"
              onClick={handleCursorModelSave}
              disabled={!cursorModelDirty || savingModel}
              className="focus-ring bg-[#3B82F6] px-3 py-1 text-xs text-white hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:opacity-40"
            >
              {savingModel ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        <input
          type="text"
          data-testid="cursor-model-input"
          value={cursorModelBuffer}
          onChange={(e) => setCursorModelBuffer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCursorModelSave();
          }}
          placeholder={CURSOR_DEFAULT_MODEL}
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#3B82F6]"
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
            <button
              onClick={saveCursorFlags}
              disabled={!cursorFlagsDirty || savingFlags}
              className="focus-ring bg-[#3B82F6] px-3 py-1 text-xs text-white hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:opacity-40"
            >
              {savingFlags ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        <input
          type="text"
          data-testid="cursor-flags-input"
          value={cursorFlagsBuffer}
          onChange={(e) => setCursorFlagsBuffer(e.target.value)}
          placeholder="--print"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#3B82F6]"
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
    api
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
      await api.updateHookEnabled(entry.scope, entry.key, next);
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
      {loading && (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse bg-glass-l1 border border-glass-edge" />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 border border-red-400/30 bg-red-400/5 px-4 py-3">
          <span className="text-sm text-red-400">{error}</span>
          <button
            className="focus-ring text-xs text-[#3B82F6] hover:text-[#60a5fa] active:text-[#93c5fd]"
            onClick={load}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <HookGroup title="Built-in" entries={builtins} emptyMsg="No built-in hooks." />
          <HookGroup title="Global" entries={globals} emptyMsg="No global hooks installed." />
          <HookGroup title="Repo" entries={repos} emptyMsg="No repo hooks from active tasks." />
        </>
      )}
    </SectionCard>
  );
}

function GeneralSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem('octomux-notifications') !== 'false',
  );
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
            localStorage.setItem('octomux-notifications', String(v));
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
          <input
            type="number"
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
            className="focus-ring w-20 border border-glass-edge bg-[#0B0C0F] px-2 py-1 text-right font-mono text-xs text-white outline-none focus:border-[#3B82F6]"
          />
        </div>
      </SettingRow>
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
      <AgentsSection scrollRef={setRef('agents')} />
      <SkillsSection scrollRef={setRef('skills')} />
      <HooksSection scrollRef={setRef('hooks')} />
      <RepoConfigsSection scrollRef={setRef('repositories')} />
      <ReviewsSection scrollRef={setRef('reviews')} />
      <EditorSection scrollRef={setRef('editor')} />
      <CodingAgentSection scrollRef={setRef('coding-agent')} />
      <ClaudeLaunchFlagsSection scrollRef={setRef('agent-launch')} />
      <AdvancedSection scrollRef={setRef('advanced')} />
    </SettingsLayout>
  );
}
