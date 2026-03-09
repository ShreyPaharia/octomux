import { Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import TaskDetail from './pages/TaskDetail';

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
      </Routes>
    </div>
  );
}
