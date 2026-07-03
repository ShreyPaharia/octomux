import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Task } from '@octomux/types';
import { taskApi } from '@/lib/api/taskApi';
import {
  type TaskMode,
  getPerTaskUiState,
  setPerTaskUiState,
} from '@/hooks/perTaskUiState';

export interface UseTaskViewModeOptions {
  taskId: string;
  task: Task | null;
  refresh: () => void;
}

export interface UseTaskViewModeResult {
  mode: TaskMode;
  setMode: React.Dispatch<React.SetStateAction<TaskMode>>;
  activeWindow: number | null;
  setActiveWindow: React.Dispatch<React.SetStateAction<number | null>>;
  gridView: boolean;
  setGridView: React.Dispatch<React.SetStateAction<boolean>>;
  localUserWindowIndex: number | null;
  setLocalUserWindowIndex: React.Dispatch<React.SetStateAction<number | null>>;
  userWindowIndex: number | null | undefined;
  creatingEditor: boolean;
  handleToggleEditor: () => Promise<void>;
}

export function useTaskViewMode({
  taskId,
  task,
  refresh,
}: UseTaskViewModeOptions): UseTaskViewModeResult {
  const [activeWindow, setActiveWindow] = useState<number | null>(null);
  const [mode, setMode] = useState<TaskMode>('agents');
  const [gridView, setGridView] = useState(false);
  const [creatingEditor, setCreatingEditor] = useState(false);
  const [searchParams] = useSearchParams();
  const agentParam = searchParams.get('agent');

  const [localUserWindowIndex, setLocalUserWindowIndex] = useState<number | null>(null);
  const userWindowIndex = task?.user_window_index ?? localUserWindowIndex;

  const prevTaskIdRef = useRef<string>(taskId);
  const activeWindowRef = useRef(activeWindow);
  const modeRef = useRef(mode);
  activeWindowRef.current = activeWindow;
  modeRef.current = mode;

  useEffect(() => {
    const prevId = prevTaskIdRef.current;
    if (prevId !== taskId) {
      setPerTaskUiState(prevId, {
        activeWindow: activeWindowRef.current,
        mode: modeRef.current,
      });
      const saved = getPerTaskUiState(taskId);
      setActiveWindow(saved?.activeWindow ?? null);
      setMode(saved?.mode ?? 'agents');
      setLocalUserWindowIndex(null);
      prevTaskIdRef.current = taskId;
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) {
      setPerTaskUiState(taskId, { activeWindow, mode });
    }
  }, [taskId, activeWindow, mode]);

  const firstAgentWindow = task?.agents?.[0]?.window_index ?? null;
  useEffect(() => {
    if (agentParam && task?.agents) {
      const agent = task.agents.find((a) => a.id === agentParam);
      if (agent) {
        setActiveWindow(agent.window_index);
        return;
      }
    }
    if (activeWindow === null && firstAgentWindow !== null) {
      setActiveWindow(firstAgentWindow);
    }
  }, [firstAgentWindow, activeWindow, agentParam, task?.agents]);

  useEffect(() => {
    if (task && task.runtime_state !== 'running') {
      setMode((m) => (m === 'editor' ? 'agents' : m));
      setLocalUserWindowIndex(null);
    }
  }, [task?.runtime_state]);

  const handleToggleEditor = useCallback(async () => {
    if (mode === 'editor') {
      setMode('agents');
      return;
    }
    if (creatingEditor) return;
    setCreatingEditor(true);
    try {
      const result = await taskApi.createUserTerminal(taskId);
      if (result.editor === 'vscode' || result.editor === 'cursor') {
        setLocalUserWindowIndex(null);
      } else {
        setLocalUserWindowIndex(result.windowIndex);
        setMode('editor');
      }
      refresh();
    } catch (err) {
      console.error('Failed to create user terminal:', err);
    } finally {
      setCreatingEditor(false);
    }
  }, [mode, taskId, creatingEditor, refresh]);

  return {
    mode,
    setMode,
    activeWindow,
    setActiveWindow,
    gridView,
    setGridView,
    localUserWindowIndex,
    setLocalUserWindowIndex,
    userWindowIndex,
    creatingEditor,
    handleToggleEditor,
  };
}
