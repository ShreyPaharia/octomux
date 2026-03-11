import { useNavigate } from 'react-router-dom';
import type { PermissionPrompt } from '../../server/types';

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function abbreviateInput(toolInput: Record<string, unknown>): string {
  const command = toolInput.command || toolInput.file_path || toolInput.pattern || '';
  const str = String(command);
  return str.length > 40 ? str.slice(0, 37) + '...' : str;
}

export function PermissionPromptRow({
  prompt,
  taskId,
}: {
  prompt: PermissionPrompt;
  taskId: string;
}) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/tasks/${taskId}?agent=${prompt.agent_id}`);
  };

  return (
    <button
      onClick={handleClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-amber-400 hover:bg-amber-500/10"
    >
      <span className="text-amber-500">&#x26A0;</span>
      <span className="text-zinc-400">{prompt.agent_label}</span>
      <span className="font-medium">
        {prompt.tool_name} {abbreviateInput(prompt.tool_input)}
      </span>
      <span className="ml-auto text-zinc-500">{timeAgo(prompt.created_at)}</span>
    </button>
  );
}
