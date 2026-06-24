import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { useAttentionIndicator } from './lib/use-attention-indicator';
import { useNotifications } from './lib/use-notifications';
import HomePage from './pages/HomePage';
import TasksPage from './pages/TasksPage';
import ReviewsPage from './pages/ReviewsPage';
import SettingsPage from './pages/SettingsPage';
import { TasksProvider, useTasksContext } from './lib/tasks-context';
import { UniversalSidebar } from './components/sidebar/universal-sidebar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { ResponsiveToaster } from './components/ResponsiveToaster';
import { PrSheet } from './components/PrSheet';
import { OfflineBanner } from './components/OfflineBanner';
import { SHIP_EVENT } from './pages/TaskDetail';
import { SetupBanner } from './components/SetupBanner';
import type { Task } from '../server/types';

// The four most-clicked nav targets stay eager so navigating to them never
// shows a Suspense fallback flash. Heavier, less-frequent routes below are lazy.
const TaskDetail = lazy(() => import('./pages/TaskDetail'));
const GridMonitor = lazy(() => import('./pages/GridMonitor'));
const SkillEditor = lazy(() => import('./pages/SkillEditor'));
const AgentEditor = lazy(() => import('./pages/AgentEditor'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const WorkspacesPage = lazy(() => import('./pages/WorkspacesPage'));
const WorkspaceDetailPage = lazy(() => import('./pages/WorkspaceDetailPage'));
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage'));
const SetupPage = lazy(() => import('./pages/SetupPage'));
const ReviewDetailPage = lazy(() => import('./pages/ReviewDetailPage'));
const OrchestratorPage = lazy(() => import('./pages/OrchestratorPage'));

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
        <AppShell />
      </TasksProvider>
    </ErrorBoundary>
  );
}

export function AppShell() {
  const { tasks, refresh: refreshTasks } = useTasksContext();
  const [prSheetTask, setPrSheetTask] = useState<Task | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId?: string }>).detail;
      if (!detail?.taskId) return;
      const task = tasks.find((t) => t.id === detail.taskId);
      if (task) setPrSheetTask(task);
    };
    window.addEventListener(SHIP_EVENT, handler);
    return () => window.removeEventListener(SHIP_EVENT, handler);
  }, [tasks]);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <OfflineBanner />
      <SetupBanner />
      <div className="flex min-h-0 flex-1">
        <ResponsiveToaster />
        <GlobalNotifications />
        <UniversalSidebar />
        <main className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
          <div className="ambient-tint-backdrop" aria-hidden="true" />
          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
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
                <Route path="/reviews" element={<ReviewsPage />} />
                <Route path="/reviews/:id" element={<ReviewDetailPage />} />
                <Route path="/monitor" element={<GridMonitor />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/skills/:name" element={<SkillEditor />} />
                <Route path="/agents/:name" element={<AgentEditor />} />
                <Route path="/chats/:id" element={<ChatPage />} />
                <Route path="/workspaces" element={<WorkspacesPage />} />
                <Route path="/workspaces/:id" element={<WorkspaceDetailPage />} />
                <Route path="/integrations" element={<IntegrationsPage />} />
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/orchestrator" element={<OrchestratorPage />} />
              </Routes>
            </Suspense>
          </div>
        </main>
        <PrSheet
          open={!!prSheetTask}
          task={prSheetTask}
          onClose={() => setPrSheetTask(null)}
          onShipped={() => refreshTasks()}
        />
        <MobileBottomNav />
      </div>
    </div>
  );
}
