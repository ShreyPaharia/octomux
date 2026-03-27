import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useSkills } from '../lib/hooks';
import { api } from '@/lib/api';
import type { OrchestratorPromptData } from '@/lib/api';

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`relative h-5 w-9 transition-colors ${checked ? 'bg-primary' : 'bg-[#2f2f2f]'}`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <h2 className="mb-4 text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
      // {label}
    </h2>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[#2f2f2f] py-3">
      <div>
        <span className="text-sm">{label}</span>
        {description && <p className="text-xs text-[#6a6a6a]">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function SkillsSection() {
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
      toast.success(`Skill "${newName.trim()}" created`);
      setShowCreate(false);
      setNewName('');
      navigate(`/skills/${encodeURIComponent(newName.trim())}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [newName, navigate]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteSkill(deleteTarget);
      toast.success(`Skill "${deleteTarget}" deleted`);
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, refresh]);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between">
        <SectionHeader label="SKILLS" />
        <button
          className="mb-4 text-xs text-[#3B82F6] hover:text-[#60a5fa]"
          onClick={() => setShowCreate(true)}
        >
          + New Skill
        </button>
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded bg-[#141414] border border-[#2f2f2f]"
            />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 rounded border border-red-400/30 bg-red-400/5 px-4 py-3">
          <span className="text-sm text-red-400">{error}</span>
          <button className="text-xs text-[#3B82F6] hover:text-[#60a5fa]" onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && skills.length === 0 && (
        <div className="py-8 text-center text-sm text-[#6a6a6a]">
          No skills installed.{' '}
          <button
            className="text-[#3B82F6] hover:text-[#60a5fa]"
            onClick={() => setShowCreate(true)}
          >
            Create your first skill
          </button>
        </div>
      )}

      {!loading && !error && skills.length > 0 && (
        <div className="space-y-0">
          {skills.map((skill) => (
            <div
              key={skill.name}
              className="flex items-center justify-between border-b border-[#2f2f2f] py-3 cursor-pointer hover:bg-[#141414]"
              onClick={() => navigate(`/skills/${encodeURIComponent(skill.name)}`)}
            >
              <div>
                <span className="text-sm font-mono">{skill.name}</span>
                {skill.description && <p className="text-xs text-[#8a8a8a]">{skill.description}</p>}
              </div>
              <button
                className="text-xs text-[#6a6a6a] hover:text-red-400"
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

      {/* Create Dialog */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="w-full max-w-md rounded border border-[#2f2f2f] bg-[#0A0A0A] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-sm font-bold">Create Skill</h3>
            <input
              type="text"
              placeholder="Skill name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              className="mb-4 w-full rounded border border-[#2f2f2f] bg-[#141414] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                className="rounded px-3 py-1.5 text-xs text-[#8a8a8a] hover:text-white"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button
                className="rounded bg-[#3B82F6] px-3 py-1.5 text-xs text-white hover:bg-[#2563eb] disabled:opacity-50"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded border border-[#2f2f2f] bg-[#0A0A0A] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-sm font-bold">Delete Skill</h3>
            <p className="mb-4 text-xs text-[#8a8a8a]">
              Are you sure you want to delete{' '}
              <span className="font-mono text-white">{deleteTarget}</span>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="rounded px-3 py-1.5 text-xs text-[#8a8a8a] hover:text-white"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                className="rounded bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function EditorSection() {
  const [editor, setEditor] = useState<string>('nvim');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setEditor(s.editor);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = async (value: string) => {
    const prev = editor;
    setEditor(value);
    try {
      await api.updateSettings({ editor: value as 'nvim' | 'vscode' | 'cursor' });
      toast.success(`Editor set to ${value}`);
    } catch (err) {
      setEditor(prev);
      toast.error(err instanceof Error ? err.message : 'Failed to update editor');
    }
  };

  if (loading) return null;

  return (
    <section className="mb-8">
      <SectionHeader label="EDITOR" />
      <SettingRow label="Editor" description="Editor to open when clicking the Editor button on tasks">
        <select
          value={editor}
          onChange={(e) => handleChange(e.target.value)}
          className="bg-[#141414] border border-[#2f2f2f] px-3 py-1 text-xs text-white outline-none focus:border-[#3B82F6]"
        >
          <option value="nvim">Neovim</option>
          <option value="vscode">VS Code</option>
          <option value="cursor">Cursor</option>
        </select>
      </SettingRow>
    </section>
  );
}

function OrchestratorPromptSection() {
  const [data, setData] = useState<OrchestratorPromptData | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savedContentRef = useRef('');
  const isDirty = content !== savedContentRef.current;

  useEffect(() => {
    api
      .getOrchestratorPrompt()
      .then((result) => {
        setData(result);
        setContent(result.content);
        savedContentRef.current = result.content;
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    try {
      await api.updateOrchestratorPrompt(content);
      savedContentRef.current = content;
      setData((prev) => (prev ? { ...prev, content, isCustom: true } : prev));
      toast.success('Prompt saved. Orchestrator restarted.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save prompt');
    } finally {
      setSaving(false);
    }
  }, [content, isDirty, saving]);

  const reset = useCallback(async () => {
    if (!window.confirm('Reset orchestrator prompt to default? This cannot be undone.')) return;
    try {
      await api.resetOrchestratorPrompt();
      const result = await api.getOrchestratorPrompt();
      setData(result);
      setContent(result.content);
      savedContentRef.current = result.content;
      toast.success('Prompt reset to default. Orchestrator restarted.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset prompt');
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [save]);

  if (loading) {
    return <p className="py-3 text-xs text-[#6a6a6a]">Loading prompt...</p>;
  }

  return (
    <>
      <SettingRow
        label="Orchestrator Prompt"
        description="Customize the orchestrator's system prompt"
      >
        <div className="flex items-center gap-2">
          {isDirty && <span className="text-xs text-[#FFB800]">unsaved</span>}
          <button
            onClick={save}
            disabled={!isDirty || saving}
            className="bg-[#3B82F6] px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </SettingRow>
      <div className="border-b border-[#2f2f2f] pb-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="mt-2 h-64 w-full resize-y border border-[#2f2f2f] bg-[#0A0A0A] p-3 font-mono text-xs leading-relaxed text-white outline-none focus:border-[#3B82F6]"
          spellCheck={false}
        />
        <div className="mt-2 flex items-center gap-3">
          {data?.isCustom && (
            <button onClick={reset} className="text-xs text-red-400 hover:text-red-300">
              Reset to Default
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export default function SettingsPage() {
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem('octomux-notifications') !== 'false',
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('octomux-sidebar-collapsed') === 'true',
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <h1 className="mb-8 font-display text-2xl font-bold">SETTINGS</h1>

        <section className="mb-8">
          <SectionHeader label="GENERAL" />
          <SettingRow label="Notifications" description="Show toast notifications for task events">
            <ToggleSwitch
              checked={notifications}
              onChange={(v) => {
                setNotifications(v);
                localStorage.setItem('octomux-notifications', String(v));
              }}
            />
          </SettingRow>
          <SettingRow label="Sidebar collapsed by default">
            <ToggleSwitch
              checked={sidebarCollapsed}
              onChange={(v) => {
                setSidebarCollapsed(v);
                localStorage.setItem('octomux-sidebar-collapsed', String(v));
              }}
            />
          </SettingRow>
        </section>

        <EditorSection />

        <section className="mb-8">
          <SectionHeader label="ORCHESTRATOR" />
          <OrchestratorPromptSection />
          <SettingRow
            label="Restart Orchestrator"
            description="Stop and restart the orchestrator process"
          >
            <button
              onClick={async () => {
                try {
                  await api.orchestratorStop();
                  await api.orchestratorStart();
                  toast.success('Orchestrator restarted');
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Failed to restart');
                }
              }}
              className="bg-[#2f2f2f] px-3 py-1 text-xs text-white hover:bg-[#3f3f3f]"
            >
              Restart
            </button>
          </SettingRow>
        </section>

        <SkillsSection />
      </div>
    </div>
  );
}
