import { useState } from 'react';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { api } from '@/lib/api';
import { COMMANDS } from '@/lib/orchestrator-commands';
import type { OrchestratorCommand } from '@/lib/orchestrator-commands';
import { CommandFieldForm } from './CommandFieldForm';

export function OrchestratorCommandBar() {
  const [sending, setSending] = useState(false);
  const [activeCommand, setActiveCommand] = useState<OrchestratorCommand | null>(null);
  const { refresh } = useOrchestratorContext();

  const sendMessage = async (message: string) => {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await api.orchestratorSend(message);
      refresh();
    } catch (err) {
      console.error('Failed to send to orchestrator:', err);
    } finally {
      setSending(false);
    }
  };

  const handleChipClick = (command: OrchestratorCommand) => {
    if (command.fields) {
      setActiveCommand(command);
      return;
    }
    setActiveCommand(null);
    sendMessage(command.buildMessage({}));
  };

  return (
    <div className="relative mb-4 border border-[#2f2f2f] bg-[#0A0A0A]">
      {activeCommand ? (
        <CommandFieldForm
          command={activeCommand}
          onSubmit={async (message) => {
            setSending(true);
            try {
              await api.orchestratorType(message);
              refresh();
              setActiveCommand(null);
            } catch (err) {
              console.error('Failed to type to orchestrator:', err);
            } finally {
              setSending(false);
            }
          }}
          onClose={() => setActiveCommand(null)}
          sending={sending}
        />
      ) : null}
      <div className="flex flex-wrap gap-1.5 border-t border-[#2f2f2f] px-3 py-2 first:border-t-0">
        {COMMANDS.map((cmd) => (
          <button
            key={cmd.slash}
            onClick={() => handleChipClick(cmd)}
            disabled={sending}
            className="border border-[#2f2f2f] bg-transparent px-2.5 py-1 text-xs text-[#8a8a8a] transition-colors hover:border-[#4a4a4a] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cmd.chipLabel}
          </button>
        ))}
      </div>
    </div>
  );
}
