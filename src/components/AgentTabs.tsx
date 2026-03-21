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
import type { Agent, UserTerminal } from '../../server/types';

interface AgentTabsProps {
  agents: Agent[];
  activeIndex: number;
  onSelect: (windowIndex: number) => void;
  onAddAgent: (prompt?: string) => void;
  onStopAgent: (agentId: string) => void;
  canAddAgent: boolean;
  userTerminals?: UserTerminal[];
  onAddTerminal?: () => void;
  onCloseTerminal?: (terminalId: string) => void;
}

export function AgentTabs({
  agents,
  activeIndex,
  onSelect,
  onAddAgent,
  onStopAgent,
  canAddAgent,
  userTerminals = [],
  onAddTerminal,
  onCloseTerminal,
}: AgentTabsProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-1 pb-1">
      {agents
        .filter((agent) => agent.status !== 'stopped')
        .map((agent) => (
          <div key={agent.id} className="group flex items-center">
            <button
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-2.5 text-sm transition-colors',
                agent.window_index === activeIndex
                  ? 'border-b-2 border-[#3B82F6] text-[#3B82F6] font-bold'
                  : 'text-[#8a8a8a] font-medium hover:text-foreground',
              )}
              onClick={() => onSelect(agent.window_index)}
            >
              {agent.status === 'running' && (
                <span
                  className={`inline-block h-2 w-2 ${
                    agent.hook_activity === 'waiting'
                      ? 'bg-[#FFB800]'
                      : agent.hook_activity === 'idle'
                        ? 'bg-[#6a6a6a]'
                        : 'animate-pulse bg-[#22C55E]'
                  }`}
                />
              )}
              {agent.label}
            </button>
            {agent.status === 'running' && (
              <button
                className="ml-0.5 hidden rounded p-0.5 text-[#6a6a6a] hover:text-destructive group-hover:inline-flex"
                onClick={(e) => {
                  e.stopPropagation();
                  onStopAgent(agent.id);
                }}
                title="Stop agent"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="10"
                  height="10"
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
      {(userTerminals.length > 0 || onAddTerminal) && (
        <div data-testid="tab-separator" className="mx-1 h-6 w-px bg-[#2f2f2f]" />
      )}
      {userTerminals.map((terminal) => (
        <div key={terminal.id} className="group flex items-center">
          <button
            className={cn(
              'flex items-center gap-1.5 px-3.5 py-2.5 text-sm transition-colors',
              terminal.window_index === activeIndex
                ? 'border-b-2 border-[#3B82F6] text-[#3B82F6] font-bold'
                : 'text-[#8a8a8a] font-medium hover:text-foreground',
            )}
            onClick={() => onSelect(terminal.window_index)}
          >
            <span
              className={`inline-block h-2 w-2 ${
                terminal.status === 'working' ? 'animate-pulse bg-[#22C55E]' : 'bg-[#6a6a6a]'
              }`}
            />
            {terminal.label}
          </button>
          {onCloseTerminal && (
            <button
              className="ml-0.5 hidden rounded p-0.5 text-[#6a6a6a] hover:text-destructive group-hover:inline-flex"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTerminal(terminal.id);
              }}
              title="Close terminal"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="10"
                height="10"
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
      {onAddTerminal && (
        <button
          className="p-[10px] text-sm text-[#6a6a6a] hover:text-foreground"
          onClick={onAddTerminal}
          title="Add terminal"
        >
          +
        </button>
      )}
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
          className="p-[10px] text-sm text-[#6a6a6a] hover:text-foreground"
          onClick={handleQuickAdd}
          title="Add agent without prompt"
        >
          +
        </button>
        <DialogTrigger
          render={
            <button
              className="rounded px-1 py-1 text-xs font-bold text-[#6a6a6a] hover:text-foreground"
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
