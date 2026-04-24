import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useAttentionIndicator } from './lib/use-attention-indicator';
import { useNotifications } from './lib/use-notifications';
import HomePage from './pages/HomePage';
import { OrchestratorProvider } from './lib/orchestrator-context';
import { TasksProvider, useTasksContext } from './lib/tasks-context';
import { UniversalSidebar } from './components/UniversalSidebar';
import { CommandPalette } from './components/CommandPalette';
import { useGlobalShortcut } from './lib/shortcuts';
import { groupTasksForSidebar } from './lib/sidebar-utils';
import {
  currentTaskIdFromPath,
  getNextSessionId,
  readCollapsedGroups,
  visibleSessionIds,
} from './lib/sidebar-nav';

const TasksPage = lazy(() => import('./pages/TasksPage'));
const TaskDetail = lazy(() => import('./pages/TaskDetail'));
const OrchestratorPage = lazy(() => import('./pages/OrchestratorPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SkillEditor = lazy(() => import('./pages/SkillEditor'));
const AgentEditor = lazy(() => import('./pages/AgentEditor'));
const ChatPage = lazy(() => import('./pages/ChatPage'));

/** Runs at app root so notifications fire on every page. */
function GlobalNotifications() {
  const { tasks } = useTasksContext();
  const navigate = useNavigate();
  useAttentionIndicator(tasks);
  useNotifications(tasks, navigate);
  return null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
          <p className="text-lg font-semibold text-destructive">Something went wrong</p>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {this.state.error.message}
          </p>
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <TasksProvider>
        <OrchestratorProvider>
          <AppShell />
        </OrchestratorProvider>
      </TasksProvider>
    </ErrorBoundary>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { tasks } = useTasksContext();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const groups = useMemo(() => groupTasksForSidebar(tasks), [tasks]);

  useGlobalShortcut({ key: 'k', mod: true }, (e) => {
    e.preventDefault();
    setPaletteOpen(true);
  });

  useGlobalShortcut({ key: 'n', mod: true, shift: true }, (e) => {
    if (paletteOpen) return;
    e.preventDefault();
    navigate('/', { replace: true });
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('focus-composer'));
    });
  });

  useGlobalShortcut({ key: 'ArrowDown', mod: true }, (e) => {
    if (paletteOpen) return;
    const visible = visibleSessionIds(groups, readCollapsedGroups(groups));
    if (visible.length === 0) return;
    e.preventDefault();
    const next = getNextSessionId(visible, currentTaskIdFromPath(location.pathname), 'next');
    if (next) navigate(`/tasks/${next}`);
  });

  useGlobalShortcut({ key: 'ArrowUp', mod: true }, (e) => {
    if (paletteOpen) return;
    const visible = visibleSessionIds(groups, readCollapsedGroups(groups));
    if (visible.length === 0) return;
    e.preventDefault();
    const next = getNextSessionId(visible, currentTaskIdFromPath(location.pathname), 'prev');
    if (next) navigate(`/tasks/${next}`);
  });

  useGlobalShortcut({ key: 'Enter', mod: true }, (e) => {
    if (paletteOpen) return;
    if (location.pathname !== '/') return;
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('submit-composer'));
  });

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          unstyled: true,
        }}
      />
      <GlobalNotifications />
      <UniversalSidebar />
      <main className="min-h-0 min-w-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Loading...
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/:id" element={<TaskDetail />} />
            <Route path="/orchestrator" element={<OrchestratorPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/skills/:name" element={<SkillEditor />} />
            <Route path="/agents/:name" element={<AgentEditor />} />
            <Route path="/chats/:id" element={<ChatPage />} />
          </Routes>
        </Suspense>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
