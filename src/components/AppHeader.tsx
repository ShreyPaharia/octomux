import { Link } from 'react-router-dom';
import { NotificationToggle } from './NotificationToggle';
import { CreateTaskDialog } from './CreateTaskDialog';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { OrchestratorToggle } from './OrchestratorPanel';

export function AppHeader() {
  const orchestrator = useOrchestratorContext();

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4">
      <Link to="/" className="flex items-center gap-2.5">
        <img src="/logo.png" alt="octomux" className="h-6 w-6 brightness-150 saturate-200" />
        <span className="text-base font-semibold tracking-tight">octomux</span>
      </Link>
      <div className="flex items-center gap-2">
        <OrchestratorToggle
          isOpen={orchestrator.isOpen}
          running={orchestrator.running}
          toggle={orchestrator.toggle}
        />
        <NotificationToggle />
        <CreateTaskDialog />
      </div>
    </header>
  );
}
