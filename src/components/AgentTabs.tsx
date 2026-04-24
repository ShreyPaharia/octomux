import { useEffect, useState } from 'react';
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
import { CloseIcon } from '@/components/icons';

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
  onMoveAgent?: (agentId: string) => void;
  onDetachAgent?: (agentId: string) => void;
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
  onMoveAgent,
  onDetachAgent,
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
            {agent.status === 'running' && (onMoveAgent || onDetachAgent) && (
              <AgentTabMenu
                agent={agent}
                onMove={onMoveAgent}
                onDetach={onDetachAgent}
                onStop={onStopAgent}
              />
            )}
            {agent.status === 'running' && !onMoveAgent && !onDetachAgent && (
              <button
                className="ml-0.5 hidden rounded p-0.5 text-[#6a6a6a] hover:text-destructive group-hover:inline-flex"
                onClick={(e) => {
                  e.stopPropagation();
                  onStopAgent(agent.id);
                }}
                title="Stop agent"
              >
                <CloseIcon />
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
              <CloseIcon />
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

function AgentTabMenu({
  agent,
  onMove,
  onDetach,
  onStop,
}: {
  agent: Agent;
  onMove?: (id: string) => void;
  onDetach?: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const timeout = window.setTimeout(() => {
      document.addEventListener('click', close);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener('click', close);
    };
  }, [open]);

  return (
    <div className="relative ml-0.5">
      <button
        className="hidden rounded p-0.5 text-[#6a6a6a] hover:text-foreground group-hover:inline-flex"
        data-testid={`agent-tab-menu-${agent.id}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Agent actions"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`agent-tab-menu-items-${agent.id}`}
          className="absolute right-0 top-full z-50 mt-1 min-w-44 bg-[#141414] border border-border py-1 text-xs outline-none"
        >
          {onMove && (
            <button
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-[#d0d0d0] hover:bg-[#1a1a1a]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onMove(agent.id);
              }}
            >
              Move to task…
            </button>
          )}
          {onDetach && (
            <button
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-[#d0d0d0] hover:bg-[#1a1a1a]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onDetach(agent.id);
              }}
            >
              Detach to chat
            </button>
          )}
          <div className="my-1 h-px bg-[#2f2f2f]" />
          <button
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-[#EF4444] hover:bg-[#1a1a1a]"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onStop(agent.id);
            }}
          >
            Stop agent
          </button>
        </div>
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
