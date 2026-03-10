import { Component, type ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import TaskDetail from './pages/TaskDetail';

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
      <div className="min-h-screen bg-background text-foreground">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
        </Routes>
      </div>
    </ErrorBoundary>
  );
}
