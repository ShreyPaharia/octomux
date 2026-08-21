/**
 * src/components/PluginActions.tsx
 *
 * Renders every `ctx.ui.action()` contribution for one slot (SHR-257,
 * following the read-only contributions in `PluginPanels.tsx` / SHR-256). A
 * plugin contributes a DECLARATION — id, label, an optional JSON Schema, an
 * optional confirm prompt — never a component or a handler. The handler runs
 * entirely in the host; what reaches this file is data, and this is the ONLY
 * place a plugin-declared trigger reaches the DOM. Clicking a button here
 * does nothing but `POST /api/plugin-ui/actions/:actionId` (`invokePluginAction`
 * in `src/lib/plugin-ui.ts`) and show the result — no plugin JavaScript is
 * ever loaded into the browser.
 *
 * `PluginActionDialog` is exported separately (not just used internally) so
 * `CommandPalette.tsx` can reuse the exact same form/confirm flow for a
 * `command: true` action instead of duplicating it.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SchemaConfigForm, defaultsFromSchema } from '@/components/schedules/SchemaConfigForm';
import { showToast } from '@/components/CustomToast';
import {
  usePluginUiActions,
  invokePluginAction,
  type UiAction,
  type UiSlot,
} from '@/lib/plugin-ui';

export interface PluginActionDialogProps {
  action: UiAction;
  /** Absent for task-free invocations (e.g. the command palette). */
  taskId?: string;
  open: boolean;
  onClose: () => void;
}

/**
 * The shared runner for an action that needs more than a bare click: a form
 * (`action.schema`), a confirmation prompt (`action.confirm`), or both. Both
 * `PluginActions` (slot buttons) and `CommandPalette` (palette rows) open
 * this same dialog rather than each rolling their own form-submit logic.
 */
export function PluginActionDialog({ action, taskId, open, onClose }: PluginActionDialogProps) {
  const [input, setInput] = useState<Record<string, unknown>>(() =>
    action.schema ? defaultsFromSchema(action.schema) : {},
  );
  const [submitting, setSubmitting] = useState(false);

  // Reseed the form defaults whenever a new action opens — `open` flips
  // false→true on every invocation since the caller unmounts/remounts (or
  // reuses) this dialog per action.
  useEffect(() => {
    if (open) setInput(action.schema ? defaultsFromSchema(action.schema) : {});
  }, [open, action]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const result = await invokePluginAction(action.actionId, {
        taskId,
        input: action.schema ? input : undefined,
      });
      showToast('success', action.label, result.message ?? 'Done');
      onClose();
    } catch (err) {
      showToast('error', action.label, (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          {action.confirm && <DialogDescription>{action.confirm}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {action.schema && (
            <SchemaConfigForm schema={action.schema} value={input} onChange={setInput} />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              data-testid="plugin-action-dialog-submit"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Running…' : 'Confirm'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface PluginActionsProps {
  slot: UiSlot;
  /** Omit for a task-free mount — an action does not require a task, so this
   *  component still renders (unlike `PluginPanels`, which drops fact-bound
   *  contributions in that mode; an action has no equivalent binding to drop). */
  taskId?: string;
  className?: string;
}

/** One button per action for `slot`. Renders nothing when there are none —
 *  a slot with no plugin actions shows no empty row. */
export function PluginActions({ slot, taskId, className }: PluginActionsProps) {
  const { actions } = usePluginUiActions(slot);
  const [dialogAction, setDialogAction] = useState<UiAction | null>(null);

  if (actions.length === 0) return null;

  const run = (action: UiAction) => {
    if (action.schema || action.confirm) {
      setDialogAction(action);
      return;
    }
    invokePluginAction(action.actionId, { taskId })
      .then((result) => showToast('success', action.label, result.message ?? 'Done'))
      .catch((err) => showToast('error', action.label, (err as Error).message));
  };

  return (
    <>
      <div className={className ?? 'flex flex-wrap gap-2 px-4 py-2'} data-testid="plugin-actions">
        {actions.map((action) => (
          <Button
            key={action.actionId}
            variant="outline"
            size="sm"
            data-testid={`plugin-action-${action.actionId}`}
            onClick={() => run(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {dialogAction && (
        <PluginActionDialog
          action={dialogAction}
          taskId={taskId}
          open
          onClose={() => setDialogAction(null)}
        />
      )}
    </>
  );
}
