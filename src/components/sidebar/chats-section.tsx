import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MoveAgentDialog } from '@/components/MoveAgentDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { taskApi } from '@/lib/api/taskApi';
import type { Agent } from '@octomux/types';
import {
  ACTIVE_ACCENT,
  ACTIVE_FILL,
  FOCUS_RING,
  NAV_INACTIVE_FG,
  RAIL_TILE_SIZE,
} from './constants';
import { ChatRowMenu } from './chat-row-menu';

// ─── Chats section ─────────────────────────────────────────────────────────

export function ChatsSection({
  collapsed,
  activePath,
}: {
  collapsed: boolean;
  activePath: string;
}) {
  const [chats, setChats] = useState<Agent[]>([]);
  const [movingAgentId, setMovingAgentId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const navigate = useNavigate();

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) return;
      const rows = (await res.json()) as Agent[];
      setChats(rows);
    } catch {
      // silent
    }
  }, []);

  const handleClose = useCallback(
    async (id: string) => {
      try {
        await taskApi.closeChat(id);
        await loadChats();
      } catch (err) {
        console.error('Failed to close chat:', err);
      }
    },
    [loadChats],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await taskApi.deleteChat(id);
        setDeleteTargetId(null);
        await loadChats();
        if (activePath === `/chats/${id}`) navigate('/');
      } catch (err) {
        console.error('Failed to delete chat:', err);
        setDeleteTargetId(null);
      }
    },
    [loadChats, activePath, navigate],
  );

  const deleteTarget = deleteTargetId ? chats.find((c) => c.id === deleteTargetId) : null;

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await loadChats();
    };
    void tick();
    const interval = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadChats]);

  if (chats.length === 0 && !movingAgentId) return null;

  return (
    <div style={{ paddingBottom: 12 }}>
      {!collapsed && chats.length > 0 && (
        <div
          className="text-[10px] font-medium tracking-wide text-muted-soft"
          style={{ padding: '0 20px 6px' }}
        >
          Chats
        </div>
      )}
      {chats.map((chat) => {
        const to = `/chats/${chat.id}`;
        const isActive = activePath === to;
        const isClosed = chat.status === 'stopped';
        if (collapsed) {
          return (
            <div key={chat.id} className="flex justify-center py-1">
              <Link
                to={to}
                title={chat.label}
                className={`flex items-center justify-center ${FOCUS_RING}`}
                style={{
                  width: RAIL_TILE_SIZE,
                  height: RAIL_TILE_SIZE,
                  borderRadius: 10,
                  backgroundColor: isActive ? ACTIVE_FILL : 'transparent',
                  color: isActive ? ACTIVE_ACCENT : NAV_INACTIVE_FG,
                }}
              >
                💬
              </Link>
            </div>
          );
        }
        return (
          <div key={chat.id} style={{ padding: '2px 12px' }}>
            <div
              className="group/chatrow flex items-center hover:bg-white/[0.04]"
              style={{
                padding: '6px 10px',
                gap: 8,
                borderRadius: 8,
                backgroundColor: isActive ? ACTIVE_FILL : 'transparent',
              }}
            >
              <Link
                to={to}
                aria-current={isActive ? 'page' : undefined}
                title={isClosed ? `${chat.label} (closed)` : chat.label}
                aria-label={chat.label}
                data-chat-status={chat.status}
                className={`min-w-0 flex-1 truncate rounded-[4px] ${FOCUS_RING}`}
                style={{
                  color: isActive ? '#3B82F6' : NAV_INACTIVE_FG,
                  fontWeight: isActive ? 600 : 500,
                  fontSize: 12,
                  opacity: isClosed ? 0.5 : 1,
                  fontStyle: isClosed ? 'italic' : 'normal',
                }}
              >
                {chat.label}
              </Link>
              <ChatRowMenu
                chatId={chat.id}
                isClosed={isClosed}
                onMoveToTask={() => setMovingAgentId(chat.id)}
                onClose={() => handleClose(chat.id)}
                onDelete={() => setDeleteTargetId(chat.id)}
              />
            </div>
          </div>
        );
      })}
      {movingAgentId && (
        <MoveAgentDialog
          open={!!movingAgentId}
          onOpenChange={(open) => !open && setMovingAgentId(null)}
          agentId={movingAgentId}
          currentTaskId={null}
          agentLabel={chats.find((c) => c.id === movingAgentId)?.label ?? 'chat'}
          onMoved={() => {
            setMovingAgentId(null);
            void loadChats();
          }}
        />
      )}
      {deleteTargetId && deleteTarget && (
        <ConfirmDeleteChatDialog
          open={!!deleteTargetId}
          onOpenChange={(open) => !open && setDeleteTargetId(null)}
          chatLabel={deleteTarget.label}
          onConfirm={() => handleDelete(deleteTargetId)}
        />
      )}
    </div>
  );
}

function ConfirmDeleteChatDialog({
  open,
  onOpenChange,
  chatLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatLabel: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="confirm-delete-chat" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete chat?</DialogTitle>
          <DialogDescription>
            This will permanently delete <span className="font-mono text-white">{chatLabel}</span>.
            Its tmux session and scratch directory will be removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-chat-confirm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
