import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { Agent } from '../../server/types';

interface AgentTabsProps {
  agents: Agent[];
  activeIndex: number;
  onSelect: (windowIndex: number) => void;
  onAddAgent: (prompt?: string) => void;
  onStopAgent: (agentId: string) => void;
  canAddAgent: boolean;
}

export function AgentTabs({
  agents,
  activeIndex,
  onSelect,
  onAddAgent,
  onStopAgent,
  canAddAgent,
}: AgentTabsProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-1 pb-1">
      {agents.map((agent) => (
        <div key={agent.id} className="group flex items-center">
          <button
            className={cn(
              'rounded-t-md px-3 py-1.5 text-sm transition-colors',
              agent.window_index === activeIndex
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground',
              agent.status === 'stopped' && 'opacity-50',
            )}
            onClick={() => onSelect(agent.window_index)}
          >
            {agent.label}
            {agent.status === 'running' && (
              <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />
            )}
          </button>
          {agent.status === 'running' && (
            <button
              className="ml-0.5 hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:inline-flex"
              onClick={(e) => {
                e.stopPropagation();
                onStopAgent(agent.id);
              }}
              title="Stop agent"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
      ))}
      {canAddAgent && <AddAgentButton onAdd={onAddAgent} />}
    </div>
  );
}

function AddAgentButton({ onAdd }: { onAdd: (prompt?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');

  function handleSubmit() {
    onAdd(prompt.trim() || undefined);
    setPrompt('');
    setOpen(false);
  }

  function handleQuickAdd() {
    onAdd();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-0.5">
        <button
          className="rounded-t-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          onClick={handleQuickAdd}
          title="Add agent without prompt"
        >
          +
        </button>
        <DialogTrigger
          render={
            <button
              className="rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
              title="Add agent with prompt"
            />
          }
        >
          ...
        </DialogTrigger>
      </div>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Agent</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-prompt">Initial Prompt (optional)</Label>
            <Textarea
              id="agent-prompt"
              placeholder="Write tests for the authentication module..."
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>Add Agent</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
