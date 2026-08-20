/**
 * src/components/PluginPanels.tsx
 *
 * Renders every `ctx.ui` contribution for one slot (SHR-256). Not wired into
 * any page by this change — see the module doc on `src/lib/plugin-ui.ts` for
 * the data layer, and the SHR-256 task report for the one line the task
 * detail page (`src/pages/TaskDetail.tsx`) needs to mount `slot="task.panel"`.
 *
 * A plugin contributes a binding, never a component (packages/plugin-api's
 * `UiRegistrar` doc) — this is the ONLY place plugin-declared UI reaches the
 * DOM, always through a renderer from `src/workflows/renderers`.
 */
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  usePluginFacts,
  usePluginUiContributions,
  type UiContribution,
  type UiSlot,
} from '@/lib/plugin-ui';
import { getRenderer } from '@/workflows/renderers';

interface PluginPanelProps {
  taskId: string;
  contribution: UiContribution;
}

/** One contribution: fetches its own fact data and renders it, so a slow or
 *  failing plugin panel never blocks its siblings. */
function PluginPanel({ taskId, contribution }: PluginPanelProps) {
  const { facts, loading, error } = usePluginFacts(taskId, contribution);
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
        ) : loading && facts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <Renderer contribution={contribution} facts={facts} />
        )}
      </CardContent>
    </Card>
  );
}

export interface PluginPanelsProps {
  slot: UiSlot;
  taskId: string;
  className?: string;
}

/** All contributions for `slot`, each in its own panel. Renders nothing when
 *  there are none — a task with no plugins installed shows no empty shell. */
export function PluginPanels({ slot, taskId, className }: PluginPanelsProps) {
  const { contributions } = usePluginUiContributions(slot);
  if (contributions.length === 0) return null;
  return (
    <div className={className ?? 'flex flex-col gap-3 px-4 py-2'} data-testid="plugin-panels">
      {contributions.map((contribution) => (
        <PluginPanel
          key={`${contribution.pluginId}:${contribution.factType}`}
          taskId={taskId}
          contribution={contribution}
        />
      ))}
    </div>
  );
}
