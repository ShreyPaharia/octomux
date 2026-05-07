import { memo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '../../server/types';
import { BoardCard } from './BoardCard';

interface DraggableBoardCardProps {
  task: Task;
  isDragging: boolean;
}

export const DraggableBoardCard = memo(function DraggableBoardCard({
  task,
  isDragging,
}: DraggableBoardCardProps) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
    data: { task },
  });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: 50,
        position: 'relative' as const,
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <BoardCard task={task} isDragging={isDragging} />
    </div>
  );
});
