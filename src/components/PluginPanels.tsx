/**
 * src/components/PluginPanels.tsx
 *
 * Renders every `ctx.ui` contribution for one slot (SHR-256, extended for
 * collection bindings in SHR-275). Wired into the task detail page
 * (`src/pages/TaskDetail.tsx`), which mounts
 * `<PluginPanels slot="task.panel" taskId={task.id} />`. See the module doc
 * on `src/lib/plugin-ui.ts` for the data layer.
 *
 * A plugin contributes a binding, never a component (packages/plugin-api's
 * `UiRegistrar` doc) — this is the ONLY place plugin-declared UI reaches the
 * DOM, always through a renderer from `src/workflows/renderers`.
 */
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  usePluginCollection,
  usePluginFacts,
  usePluginUiContributions,
  type CollectionRecord,
  type PluginFact,
  type UiContribution,
  type UiSlot,
} from '@/lib/plugin-ui';
import { getRenderer } from '@/workflows/renderers';

interface PluginPanelProps {
  taskId: string;
  contribution: UiContribution;
}

/**
 * Adapts collection records into the `PluginFact[]` shape every renderer in
 * `src/workflows/renderers` already knows how to draw, so a collection-bound
 * panel needs zero renderer-side changes. `seq` is the record's position in
 * the response (a collection has no incrementing sequence the way a fact
 * log does), `payload` is the plugin's record, `type` is the qualified
 * collection name, and `createdAt` reads the record's `updatedAt` — a
 * renderer's "when" column should reflect the last write, not the original
 * insert.
 */
function recordsAsFacts(records: CollectionRecord[]): PluginFact[] {
  return records.map((r, i) => ({
    seq: i,
    taskId: '',
    type: r.collection,
    payload: r.record,
    createdAt: r.updatedAt,
  }));
}

/** One contribution: fetches its own data and renders it, so a slow or
 *  failing plugin panel never blocks its siblings.
 *
 *  Both `usePluginFacts` and `usePluginCollection` are called unconditionally
 *  (rules of hooks) — each is a no-op fetch when the contribution isn't
 *  bound its way (see the guards in `src/lib/plugin-ui.ts`), so only the one
 *  matching the binding actually does work. */
function PluginPanel({ taskId, contribution }: PluginPanelProps) {
  const factsResult = usePluginFacts(taskId, contribution);
  const collectionResult = usePluginCollection(contribution);
  const isCollectionBound = contribution.collectionName !== undefined;
  const { facts, loading, error } = isCollectionBound
    ? {
        facts: recordsAsFacts(collectionResult.records),
        loading: collectionResult.loading,
        error: collectionResult.error,
      }
    : factsResult;
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
      {contributions.map((contribution, i) => (
        <PluginPanel
          // factType/collectionName are mutually exclusive and either can be
          // absent (a panel with neither binding must still render, not
          // crash) — fall back through both, then the index, so the key is
          // always defined and stable per contribution.
          key={`${contribution.pluginId}:${contribution.factType ?? contribution.collectionName ?? i}`}
          taskId={taskId}
          contribution={contribution}
        />
      ))}
    </div>
  );
}
