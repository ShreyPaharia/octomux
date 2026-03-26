import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useTasks } from './lib/hooks';
import { useAttentionIndicator } from './lib/use-attention-indicator';
import { useNotifications } from './lib/use-notifications';
import Dashboard from './pages/Dashboard';
import { OrchestratorProvider } from './lib/orchestrator-context';
import { UniversalSidebar } from './components/UniversalSidebar';

const TaskDetail = lazy(() => import('./pages/TaskDetail'));
const OrchestratorPage = lazy(() => import('./pages/OrchestratorPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

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
                <Route path="/" element={<Dashboard />} />
                <Route path="/tasks/:id" element={<TaskDetail />} />
                <Route path="/orchestrator" element={<OrchestratorPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </OrchestratorProvider>
    </ErrorBoundary>
  );
}
