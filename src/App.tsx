import { Component, lazy, type ReactNode } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useTasks } from './lib/hooks';
import { useAttentionIndicator } from './lib/use-attention-indicator';
import { useNotifications } from './lib/use-notifications';
import Dashboard from './pages/Dashboard';
import TaskDetailLayout from './components/TaskDetailLayout';
import { OrchestratorProvider } from './lib/orchestrator-context';
import { AppHeader } from './components/AppHeader';
import { OrchestratorModal } from './components/OrchestratorPanel';

const TaskDetail = lazy(() => import('./pages/TaskDetail'));

/** Runs at app root so notifications fire on every page. */
function GlobalNotifications() {
  const { tasks } = useTasks();
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
      <OrchestratorProvider>
        <div className="flex h-screen flex-col bg-background text-foreground">
          <Toaster theme="dark" position="bottom-right" richColors />
          <GlobalNotifications />
          <AppHeader />
          <div className="min-h-0 flex-1">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route element={<TaskDetailLayout />}>
                <Route path="/tasks/:id" element={<TaskDetail />} />
              </Route>
            </Routes>
          </div>
        </div>
        <OrchestratorModal />
      </OrchestratorProvider>
    </ErrorBoundary>
  );
}
