import { memo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '@octomux/types';
import { BoardCard } from './BoardCard';

interface DraggableBoardCardProps {
  task: Task;
  isDragging: boolean;
  graceHours?: number;
}

export const DraggableBoardCard = memo(function DraggableBoardCard({
  task,
  isDragging,
  graceHours = 6,
}: DraggableBoardCardProps) {
  const isTrashed = task.deleted_at !== null;

  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
    data: { task },
    disabled: isTrashed,
  });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: 50,
        position: 'relative' as const,
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...(isTrashed ? {} : { ...listeners, ...attributes })}>
      <BoardCard task={task} isDragging={isDragging} graceHours={graceHours} />
    </div>
  );
});
