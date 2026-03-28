import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { showToast } from '@/components/CustomToast';

export default function AgentEditor() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [content, setContent] = useState('');
  const [defaultContent, setDefaultContent] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savedContentRef = useRef('');
  const isDirty = content !== savedContentRef.current;

  useEffect(() => {
    if (!name) return;
    api
      .getAgent(name)
      .then((agent) => {
        setContent(agent.content);
        setDefaultContent(agent.defaultContent);
        setIsCustom(agent.isCustom);
        savedContentRef.current = agent.content;
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [name]);

  const save = useCallback(async () => {
    if (!name || !isDirty || saving) return;
    setSaving(true);
    try {
      await api.saveAgent(name, content);
      savedContentRef.current = content;
      setIsCustom(true);
      showToast('success', 'SAVED', `Agent "${name}" saved`);
    } catch (err) {
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [name, content, isDirty, saving]);

  const reset = useCallback(async () => {
    if (!name) return;
    if (!window.confirm(`Reset "${name}" to default? Your customizations will be lost.`)) return;
    try {
      await api.resetAgent(name);
      setContent(defaultContent);
      savedContentRef.current = defaultContent;
      setIsCustom(false);
      showToast('success', 'RESET', `Agent "${name}" reset to default`);
    } catch (err) {
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to reset');
    }
  }, [name, defaultContent]);

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

  const handleBack = useCallback(() => {
    if (isDirty) {
      const confirmed = window.confirm('You have unsaved changes. Discard them?');
      if (!confirmed) return;
    }
    navigate('/settings');
  }, [isDirty, navigate]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[#6a6a6a]">Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-red-400">{error}</p>
        <button
          onClick={() => navigate('/settings')}
          className="text-xs text-[#3B82F6] hover:underline"
        >
          Back to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[#2f2f2f] px-6 py-4">
        <div className="flex items-center gap-3">
          <button onClick={handleBack} className="text-sm text-[#6a6a6a] hover:text-white">
            &larr;
          </button>
          <span className="font-mono text-lg font-bold">{name}</span>
          {isCustom && <span className="text-xs text-[#FFB800]">custom</span>}
          {isDirty && <span className="text-xs text-[#FFB800]">unsaved</span>}
        </div>
        <div className="flex items-center gap-2">
          {isCustom && defaultContent && (
            <button onClick={reset} className="px-3 py-2 text-xs text-red-400 hover:text-red-300">
              Reset to Default
            </button>
          )}
          <button
            onClick={save}
            disabled={!isDirty || saving}
            className="bg-[#3B82F6] px-4 py-2 text-xs text-white disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      <div className="flex-1 p-6">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="h-full min-h-[500px] w-full resize-none border border-[#2f2f2f] bg-[#0A0A0A] p-4 font-mono text-sm leading-relaxed text-white outline-none focus:border-[#3B82F6]"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
