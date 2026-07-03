import { Button } from '@/components/ui/button';
import { DiffViewer } from '@/components/DiffViewer';
import { ReviewBaseRefBanner } from '@/components/ReviewBaseRefBanner';
import { DiffRangePicker } from '@/components/DiffRangePicker';
import { CommentQueueDrawer } from '@/components/CommentQueueDrawer';
import { CommentsSidePanel } from '@/components/CommentsSidePanel';
import { DiffKeybindCheatSheet } from '@/components/task-detail/DiffKeybindCheatSheet';
import { CommentsContext } from '@/hooks/useTaskComments';
import type { DiffRange, DiffSummaryResponse } from '@/lib/api/taskApi';
import type { Agent, Task } from '@octomux/types';
import type { DiffFileListHandle } from '@/components/DiffFileList';
import type { QueuedComment } from '@/hooks/useReviewQueue';

export interface TaskDetailDiffViewProps {
  task: Task;
  range: DiffRange;
  diffSummary: DiffSummaryResponse | null;
  currentRangeLabel: string;
  showCommentsPanel: boolean;
  filesInDiffSet: Set<string>;
  diffListRef: React.RefObject<DiffFileListHandle | null>;
  reviewQueueComments: QueuedComment[];
  commentCount: number;
  taskComments: React.ComponentProps<typeof CommentsContext.Provider>['value'];
  onRangeChange: (range: DiffRange) => void;
  onBaseChange: (baseBranch: string) => Promise<void>;
  onRefetchDiff: () => Promise<void>;
  onJumpToNextUnreviewed: () => void;
  onToggleCommentsPanel: () => void;
  onCloseCommentsPanel: () => void;
  onSelectionChange: (path: string | null) => void;
  onSummaryLoaded: (summary: DiffSummaryResponse) => void;
  onToggleReviewed: (filePath: string, currentlyReviewed: boolean) => Promise<void>;
  onFilesChange: (files: string[]) => void;
  onJumpToComment: (filePath: string, line: number, side: 'old' | 'new', commentId: string) => void;
  onQueueRemove: (id: string) => void;
  onQueueJumpTo: (path: string) => void;
  onSendBatch: () => Promise<void>;
}

export function TaskDetailDiffView({
  task,
  range,
  diffSummary,
  currentRangeLabel,
  showCommentsPanel,
  filesInDiffSet,
  diffListRef,
  reviewQueueComments,
  commentCount,
  taskComments,
  onRangeChange,
  onBaseChange,
  onRefetchDiff,
  onJumpToNextUnreviewed,
  onToggleCommentsPanel,
  onCloseCommentsPanel,
  onSelectionChange,
  onSummaryLoaded,
  onToggleReviewed,
  onFilesChange,
  onJumpToComment,
  onQueueRemove,
  onQueueJumpTo,
  onSendBatch,
}: TaskDetailDiffViewProps) {
  const agents: Agent[] = task.agents ?? [];

  return (
    <CommentsContext.Provider value={taskComments}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {diffSummary && diffSummary.base_ref ? (
          <ReviewBaseRefBanner
            baseRef={diffSummary.base_ref}
            baseIsStale={!!diffSummary.base_is_stale}
            totalCount={diffSummary.total_count ?? 0}
            reviewedCount={diffSummary.reviewed_count ?? 0}
            onRefresh={onRefetchDiff}
            onJumpToNextUnreviewed={onJumpToNextUnreviewed}
            currentRangeLabel={currentRangeLabel}
            rangePicker={
              <DiffRangePicker
                taskId={task.id}
                currentBaseBranch={task.base_branch}
                range={range}
                onRangeChange={onRangeChange}
                onBaseChange={onBaseChange}
              />
            }
            rightSlot={
              <Button
                variant="outline"
                size="xs"
                data-testid="comments-toggle"
                data-active={showCommentsPanel ? 'true' : undefined}
                className={
                  showCommentsPanel ? 'border-primary/40 bg-primary/15 text-primary' : undefined
                }
                onClick={onToggleCommentsPanel}
              >
                Comments ({commentCount})
              </Button>
            }
          />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <DiffViewer
              taskId={task.id}
              isRunning={task.runtime_state === 'running'}
              onSelectionChange={onSelectionChange}
              onSummaryLoaded={onSummaryLoaded}
              onToggleReviewed={onToggleReviewed}
              range={range}
              listRef={diffListRef}
              enableComments={true}
              agents={agents}
              onFilesChange={onFilesChange}
            />
          </div>
          {showCommentsPanel ? (
            <CommentsSidePanel
              agents={agents}
              filesInDiff={filesInDiffSet}
              rangeIsBase={range.kind === 'base'}
              onJumpTo={onJumpToComment}
              onClose={onCloseCommentsPanel}
            />
          ) : null}
          {reviewQueueComments.length > 0 ? (
            <CommentQueueDrawer
              comments={reviewQueueComments}
              onRemove={onQueueRemove}
              onJumpTo={onQueueJumpTo}
              onSend={onSendBatch}
            />
          ) : null}
        </div>
        <DiffKeybindCheatSheet />
      </div>
    </CommentsContext.Provider>
  );
}
