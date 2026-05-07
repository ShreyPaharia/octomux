import { memo } from 'react';

interface EmptyColumnPlaceholderProps {
  isOver: boolean;
}

export const EmptyColumnPlaceholder = memo(function EmptyColumnPlaceholder({
  isOver,
}: EmptyColumnPlaceholderProps) {
  return (
    <div
      className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[#2f2f2f] py-6 text-[11px] text-[#3a3a3a] transition-colors"
      style={{
        borderColor: isOver ? 'rgba(59, 130, 246, 0.4)' : undefined,
        color: isOver ? 'rgba(59, 130, 246, 0.5)' : undefined,
      }}
    >
      {isOver ? 'Drop here' : 'Empty'}
    </div>
  );
});
