import { memo } from 'react';
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

export const PermissionPromptRow = memo(function PermissionPromptRow({
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
    <div className="w-full border border-[#FFB80040] bg-[#FFB80010] px-[20px] py-[14px]">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-block h-[10px] w-[10px] animate-pulse bg-[#FFB800]" />
        <span className="text-xs font-bold uppercase tracking-wide text-[#FFB800]">
          {prompt.agent_label} — PERMISSION REQUIRED
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-[#6a6a6a]">
          {timeAgo(prompt.created_at)}
        </span>
      </div>
      {/* Details */}
      <div className="mb-3 flex flex-col gap-0.5">
        <span className="text-xs text-white">
          {prompt.tool_name} {abbreviateInput(prompt.tool_input)}
        </span>
        <span className="text-[11px] text-[#6a6a6a]">{JSON.stringify(prompt.tool_input)}</span>
      </div>
      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleClick}
          className="border-0 bg-[#22C55E] px-3 py-1 text-xs font-bold text-[#0C0C0C] transition-opacity hover:opacity-90"
        >
          APPROVE
        </button>
        <button
          onClick={(e) => e.stopPropagation()}
          className="border border-[#EF4444] bg-transparent px-3 py-1 text-xs font-bold text-[#EF4444] transition-opacity hover:opacity-90"
        >
          DENY
        </button>
      </div>
    </div>
  );
});
