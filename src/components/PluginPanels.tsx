/**
 * src/components/PluginPanels.tsx
 *
 * Renders every `ctx.ui` contribution for one slot (SHR-256, collapsed onto
 * `ctx.records` in SHR-282). Wired into the task detail page
 * (`src/pages/TaskDetail.tsx`), which mounts
 * `<PluginPanels slot="task.panel" taskId={task.id} />`. Also mounted
 * task-free at `src/pages/SettingsPage.tsx` as
 * `<PluginPanels slot="settings.card" />`. See the module doc on
 * `src/lib/plugin-ui.ts` for the data layer — which fetch a contribution's
 * records uses is decided here by whether `taskId` was passed to THIS
 * component, never by a property of the contribution: SHR-282 removed the
 * fact/collection split, so `render` (server) and this component (client)
 * both stopped branching on binding kind.
 *
 * A plugin contributes a binding, never a component (packages/plugin-api's
 * `UiRegistrar` doc) — this is the ONLY place plugin-declared UI reaches the
 * DOM, always through a renderer from `src/workflows/renderers`.
 *
 * Also renders `PluginActions` (SHR-257) above the panels for the same slot —
 * an action is a write-capable sibling of these read-only panels, and a slot
 * with actions but no panels still needs to render, see `PluginPanels` below.
 */
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  usePluginRecords,
  usePluginUiContributions,
  type UiContribution,
  type UiSlot,
} from '@/lib/plugin-ui';
import { getRenderer } from '@/workflows/renderers';
import { PluginActions } from '@/components/PluginActions';

interface PluginPanelProps {
  /** Absent in task-free mode (e.g. mounted at `settings.card`) — see
   *  `usePluginRecords`. */
  taskId?: string;
  contribution: UiContribution;
}

/** One contribution: fetches its own data and renders it, so a slow or
 *  failing plugin panel never blocks its siblings. */
function PluginPanel({ taskId, contribution }: PluginPanelProps) {
  const { records, loading, error } = usePluginRecords(contribution, taskId);
  const Renderer = getRenderer(contribution.as);
  return (
    <Card size="sm">
      {contribution.title && (
        <CardHeader>
          <CardTitle>{contribution.title}</CardTitle>
        </CardHeader>
      )}
      <CardContent>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : loading && records.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <Renderer contribution={contribution} records={records} />
        )}
      </CardContent>
    </Card>
  );
}

export interface PluginPanelsProps {
  slot: UiSlot;
  /** Omit for a task-free mount (e.g. `slot="settings.card"`) — every
   *  contribution then reads its full store instead of one task's rows, see
   *  `usePluginRecords`. */
  taskId?: string;
  className?: string;
}

/** All contributions for `slot`, each in its own panel. Renders nothing when
 *  there are none — a task with no plugins installed shows no empty shell. */
export function PluginPanels({ slot, taskId, className }: PluginPanelsProps) {
  const { contributions } = usePluginUiContributions(slot);
  return (
    <>
      <PluginActions slot={slot} taskId={taskId} />
      {contributions.length > 0 && (
        <div className={className ?? 'flex flex-col gap-3 px-4 py-2'} data-testid="plugin-panels">
          {contributions.map((contribution) => (
            <PluginPanel
              key={`${contribution.pluginId}:${contribution.recordStore}`}
              taskId={taskId}
              contribution={contribution}
            />
          ))}
        </div>
      )}
    </>
  );
}
