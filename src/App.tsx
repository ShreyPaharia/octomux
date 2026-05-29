import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useAttentionIndicator } from './lib/use-attention-indicator';
import { useNotifications } from './lib/use-notifications';
import HomePage from './pages/HomePage';
import TasksPage from './pages/TasksPage';
import ReviewsPage from './pages/ReviewsPage';
import SettingsPage from './pages/SettingsPage';
import { TasksProvider, useTasksContext } from './lib/tasks-context';
import { UniversalSidebar } from './components/UniversalSidebar';
import { PrSheet } from './components/PrSheet';
import { OfflineBanner } from './components/OfflineBanner';
import { SHIP_EVENT } from './pages/TaskDetail';
import { SetupBanner } from './components/SetupBanner';
import type { Task } from '../server/types';

// Top-level nav targets are eager — lazy() + React 19 concurrent Suspense
// can deadlock when navigating away from a heavy page (ReviewDetailPage
// with many Monaco editors): the lazy import never starts because the
// scheduler keeps yielding back to in-flight Monaco effects, leaving the
// URL updated but the route never swapping. Eager imports of the targets
// users click most often avoid the Suspense boundary entirely.
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
    <div className="flex h-screen flex-col bg-background text-foreground">
      <OfflineBanner />
      <SetupBanner />
      <div className="flex min-h-0 flex-1">
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            unstyled: true,
          }}
        />
        <GlobalNotifications />
        <UniversalSidebar />
        <main className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
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
      </div>
    </div>
  );
}
