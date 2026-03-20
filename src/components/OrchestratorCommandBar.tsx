import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { api } from '@/lib/api';
import { COMMANDS, filterCommands } from '@/lib/orchestrator-commands';
import type { OrchestratorCommand } from '@/lib/orchestrator-commands';
import { CommandFieldForm } from './CommandFieldForm';

export function OrchestratorCommandBar() {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeCommand, setActiveCommand] = useState<OrchestratorCommand | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { open, refresh } = useOrchestratorContext();

  const filteredCommands = input.startsWith('/') ? filterCommands(input.slice(1)) : [];

  const sendMessage = async (message: string) => {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await api.orchestratorSend(message);
      setInput('');
      refresh();
      open();
    } catch (err) {
      console.error('Failed to send to orchestrator:', err);
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => sendMessage(input.trim());

  const slashMenuOpen = showSlashMenu && input.startsWith('/') && filteredCommands.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleChipClick(filteredCommands[selectedIndex]);
        setShowSlashMenu(false);
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowSlashMenu(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (activeCommand) {
        setActiveCommand(null);
      } else {
        setInput('');
      }
    }
  };

  const handleChipClick = (command: OrchestratorCommand) => {
    if (command.fields) {
      setActiveCommand(command);
      setShowSlashMenu(false);
      return;
    }
    // No fields — send immediately
    setActiveCommand(null);
    sendMessage(command.buildMessage({}));
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    if (value.startsWith('/')) {
      setShowSlashMenu(true);
      setSelectedIndex(0);
    } else {
      setShowSlashMenu(false);
    }
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 80)}px`;
  };

  return (
    <div className="relative mb-4 rounded-xl border border-border bg-card">
      {activeCommand ? (
        <CommandFieldForm
          command={activeCommand}
          onSubmit={(message) => {
            sendMessage(message);
            setActiveCommand(null);
          }}
          onClose={() => setActiveCommand(null)}
          sending={sending}
        />
      ) : (
        <div className="flex items-end gap-2 p-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask the orchestrator anything..."
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button
            size="sm"
            disabled={!input.trim() || sending}
            onClick={handleSend}
            aria-label="Send"
            className="shrink-0"
          >
            {sending ? (
              <LoadingIcon className="h-4 w-4 animate-spin" />
            ) : (
              <SendIcon className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
        {COMMANDS.map((cmd) => (
          <button
            key={cmd.slash}
            onClick={() => handleChipClick(cmd)}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {cmd.chipLabel}
          </button>
        ))}
      </div>
      {slashMenuOpen && (
        <div className="absolute top-full left-0 z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-1 shadow-md">
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.slash}
              onClick={() => {
                handleChipClick(cmd);
                setShowSlashMenu(false);
              }}
              className={`flex w-full flex-col items-start rounded-md px-3 py-2 text-left text-sm ${
                i === selectedIndex ? 'bg-muted' : ''
              }`}
            >
              <span className="font-semibold">{cmd.slash}</span>
              <span className="text-xs text-muted-foreground">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

function LoadingIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
