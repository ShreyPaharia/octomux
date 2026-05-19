import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useSkills, useRepoConfigs, useAgents, useHarnesses } from '../lib/hooks';
import { api } from '@/lib/api';
import type { RepoConfig, HookRegistryEntry } from '@/lib/api';
import { showToast } from '@/components/CustomToast';
import { repoName } from '@/lib/utils';
import { GlassPanel } from '@/components/ui/glass-panel';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

const ROW_DIVIDER: CSSProperties = { borderBottom: '1px solid rgba(255,255,255,0.10)' };

const TOGGLE_ON_STYLE: CSSProperties = {
  background: 'linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%)',
  boxShadow: '0 0 12px rgba(59,130,246,0.45), inset 0 1px 0 rgba(255,255,255,0.35)',
};

const TOGGLE_OFF_STYLE: CSSProperties = {
  backgroundColor: 'rgba(255,255,255,0.08)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)',
  border: '1px solid rgba(255,255,255,0.14)',
};

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="focus-ring relative h-5 w-9 transition-colors disabled:opacity-40"
      style={checked ? TOGGLE_ON_STYLE : TOGGLE_OFF_STYLE}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  );
}

function SettingRow({
  label,
  description,
  children,
  lastRow = false,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  lastRow?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between py-3"
      style={lastRow ? undefined : ROW_DIVIDER}
    >
      <div>
        <span className="text-sm">{label}</span>
        {description && <p className="text-xs text-[#b5b5bd]">{description}</p>}
      </div>
      {children}
    </div>
  );
}

interface SectionCardProps {
  id: string;
  title: string;
  count?: string | number;
  help?: string;
  trailing?: ReactNode;
  children: ReactNode;
  scrollRef: (el: HTMLElement | null) => void;
}

function SectionCard({ id, title, count, help, trailing, children, scrollRef }: SectionCardProps) {
  return (
    <section id={`section-${id}`} ref={scrollRef} className="mb-6 scroll-mt-6">
      <GlassPanel level={2} className="px-5">
        <header
          className="flex items-center justify-between"
          style={{ ...ROW_DIVIDER, padding: '18px 0' }}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-white">{title}</h2>
            {count !== undefined && <span className="text-xs text-[#8a8a8a]">{count}</span>}
            {help && <span className="text-xs text-[#8a8a8a]">{help}</span>}
          </div>
          {trailing}
        </header>
        <div className="py-2">{children}</div>
      </GlassPanel>
    </section>
  );
}

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
      title="AGENTS"
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
      title="SKILLS"
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

function AddChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex items-center gap-1 rounded-md border border-[#3B82F6]/40 px-2.5 py-1 text-xs font-medium text-[#60a5fa] transition-colors hover:bg-[#3B82F6]/20 active:bg-[#3B82F6]/30 disabled:opacity-40"
      style={{ backgroundColor: 'rgba(59,130,246,0.12)' }}
    >
      {label}
    </button>
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
      title="REPOSITORIES"
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
    <SectionCard id="editor" title="EDITOR" scrollRef={scrollRef}>
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
    <SectionCard id="agent-launch" title="AGENT LAUNCH FLAGS" scrollRef={scrollRef}>
      {envOverride !== null && (
        <div className="mb-3 border border-[#FFB800]/40 bg-[#FFB800]/5 px-3 py-2 text-xs text-[#FFB800]">
          Overridden by OCTOMUX_CLAUDE_FLAGS env var:{' '}
          <span className="font-mono text-[#FFB800]">{envOverride}</span>
        </div>
      )}

      <SettingRow
        label="--dangerously-skip-permissions"
        description="Launch claude without permission prompts. Agents can run arbitrary shell commands without asking."
      >
        <ToggleSwitch checked={dangerouslySkip} onChange={handleToggle} />
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

function CodingAgentSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const { harnesses, loading: harnessesLoading } = useHarnesses();
  const [defaultHarnessId, setDefaultHarnessIdState] = useState<string>('claude-code');
  const [cursorForce, setCursorForce] = useState(false);
  const [cursorFlagsSaved, setCursorFlagsSaved] = useState('');
  const [cursorFlagsBuffer, setCursorFlagsBuffer] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingFlags, setSavingFlags] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setDefaultHarnessIdState(s.defaultHarnessId ?? 'claude-code');
        const sub = (s.harnesses?.cursor ?? {}) as { flags?: string; force?: boolean };
        setCursorForce(Boolean(sub.force));
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

  const handleCursorForceToggle = async (next: boolean) => {
    const prev = cursorForce;
    setCursorForce(next);
    try {
      await api.updateSettings({
        harnesses: {
          cursor: { force: next, ...(cursorFlagsSaved ? { flags: cursorFlagsSaved } : {}) },
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
          cursor: {
            ...(cursorForce ? { force: true } : {}),
            ...(cursorFlagsBuffer.trim() ? { flags: cursorFlagsBuffer.trim() } : {}),
          },
        },
      });
      const sub = (result.harnesses?.cursor ?? {}) as { flags?: string };
      setCursorFlagsSaved(sub.flags ?? '');
      setCursorFlagsBuffer(sub.flags ?? '');
      showToast('success', 'CURSOR', 'Cursor flags saved');
    } catch (err) {
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to save flags');
    } finally {
      setSavingFlags(false);
    }
  }, [cursorFlagsDirty, savingFlags, cursorFlagsBuffer, cursorForce]);

  if (loading || harnessesLoading) return null;

  return (
    <SectionCard id="coding-agent" title="CODING AGENT" scrollRef={scrollRef}>
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

      <SettingRow
        label="--force (skip permissions)"
        description="Launch cursor-agent with --force so it never blocks on per-tool permission prompts."
      >
        <ToggleSwitch checked={cursorForce} onChange={handleCursorForceToggle} />
      </SettingRow>

      {cursorForce && (
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
              Extra flags appended to the cursor-agent launch command
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
          placeholder="--model gpt-5 --print"
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
                  <ToggleSwitch checked={entry.enabled} onChange={(v) => handleToggle(entry, v)} />
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
      title="HOOKS"
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

type SectionId =
  | 'general'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'repositories'
  | 'editor'
  | 'coding-agent'
  | 'agent-launch';

const NAV_ITEMS: { id: SectionId; label: string }[] = [
  { id: 'general', label: 'GENERAL' },
  { id: 'agents', label: 'AGENTS' },
  { id: 'skills', label: 'SKILLS' },
  { id: 'hooks', label: 'HOOKS' },
  { id: 'repositories', label: 'REPOSITORIES' },
  { id: 'editor', label: 'EDITOR' },
  { id: 'coding-agent', label: 'CODING AGENT' },
  { id: 'agent-launch', label: 'AGENT LAUNCH' },
];

// Extra items that navigate away (not in-page scroll)
const NAV_EXTRA_ITEMS: { id: string; label: string; to: string }[] = [
  { id: 'integrations', label: 'INTEGRATIONS', to: '/integrations' },
];

function GeneralSection({ scrollRef }: { scrollRef: (el: HTMLElement | null) => void }) {
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem('octomux-notifications') !== 'false',
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('octomux-sidebar-collapsed') === 'true',
  );
  return (
    <SectionCard id="general" title="GENERAL" scrollRef={scrollRef}>
      <SettingRow label="Notifications" description="Show toast notifications for task events">
        <ToggleSwitch
          checked={notifications}
          onChange={(v) => {
            setNotifications(v);
            localStorage.setItem('octomux-notifications', String(v));
          }}
        />
      </SettingRow>
      <SettingRow label="Sidebar collapsed by default" lastRow>
        <ToggleSwitch
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

export default function SettingsPage() {
  const navigate = useNavigate();
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activeSection, setActiveSection] = useState<SectionId>('general');

  const setRef = useCallback(
    (id: SectionId) => (el: HTMLElement | null) => {
      sectionRefs.current[id] = el;
    },
    [],
  );

  const scrollTo = useCallback((id: SectionId) => {
    setActiveSection(id);
    const el = sectionRefs.current[id];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      <GlassPanel level={1}>
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h1 className="font-display text-[30px] font-semibold leading-none text-white">
              Settings
            </h1>
            <p className="mt-1 font-mono text-[11px] text-[#8a8a8a]">
              // workspace preferences · synced to ~/.octomux/config.json
            </p>
          </div>
        </div>
      </GlassPanel>

      <div className="flex min-h-0 flex-1">
        <GlassPanel
          level={1}
          className="flex shrink-0 flex-col gap-1 border-r border-glass-edge py-4"
          style={{ width: 220 }}
        >
          <nav aria-label="Settings sections" className="flex flex-col">
            {NAV_ITEMS.map((item) => {
              const isActive = item.id === activeSection;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  data-active={isActive ? 'true' : undefined}
                  onClick={() => scrollTo(item.id)}
                  className={`focus-ring relative px-5 py-2 text-left text-[11px] font-bold uppercase tracking-wider transition-colors ${
                    isActive ? 'text-[#60a5fa]' : 'text-[#b5b5bd] hover:text-white'
                  }`}
                  style={
                    isActive
                      ? {
                          backgroundColor: 'rgba(59,130,246,0.12)',
                          boxShadow: 'inset 2px 0 0 0 #3B82F6',
                        }
                      : undefined
                  }
                >
                  {item.label}
                </button>
              );
            })}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '8px 0' }} />
            {NAV_EXTRA_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`settings-nav-${item.id}`}
                onClick={() => navigate(item.to)}
                className="focus-ring relative px-5 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-[#b5b5bd] transition-colors hover:text-white"
              >
                {item.label} ↗
              </button>
            ))}
          </nav>
        </GlassPanel>

        <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
          <div className="mx-auto max-w-3xl">
            <GeneralSection scrollRef={setRef('general')} />
            <AgentsSection scrollRef={setRef('agents')} />
            <SkillsSection scrollRef={setRef('skills')} />
            <HooksSection scrollRef={setRef('hooks')} />
            <RepoConfigsSection scrollRef={setRef('repositories')} />
            <EditorSection scrollRef={setRef('editor')} />
            <CodingAgentSection scrollRef={setRef('coding-agent')} />
            <ClaudeLaunchFlagsSection scrollRef={setRef('agent-launch')} />
          </div>
        </div>
      </div>
    </div>
  );
}
