/**
 * src/workflows/renderers/index.tsx
 *
 * The client-owned renderer registry behind `ctx.ui.panel({ as })`
 * (SHR-256). A plugin ships zero browser JavaScript — it names a renderer,
 * the client looks it up here. Deliberately tiny: this is plumbing, not a
 * design exercise, and reuses `src/components/ui/*` primitives where one fits.
 *
 * `getRenderer(name)` MUST NOT return undefined — an unknown renderer name
 * degrades to `json`, never a blank panel (plans/2026-08-20-plugin-runtime-p0.md,
 * Task D item 3).
 */
import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/orchestrator/Markdown';
import type { PluginFact, UiContribution } from '@/lib/plugin-ui';

export interface RendererProps {
  contribution: UiContribution;
  facts: PluginFact[];
}

function latestPayload(facts: PluginFact[]): unknown {
  return facts.length > 0 ? facts[facts.length - 1].payload : undefined;
}

function payloadField(payload: unknown, key: string | undefined): unknown {
  if (!key || typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** `value`/text field a renderer displays: the declared `contribution.value` key
 *  when the payload is an object, or the payload itself when it's already a
 *  scalar (a plugin publishing `put(task, 'status', 'green')` shouldn't need
 *  `{ value: 'green' }` just to satisfy the binding). */
function primaryValue(contribution: UiContribution, facts: PluginFact[]): unknown {
  const payload = latestPayload(facts);
  if (typeof payload === 'object' && payload !== null) {
    return payloadField(payload, contribution.value ?? 'value');
  }
  return payload;
}

function EmptyState() {
  return <p className="text-xs text-muted-foreground">No data yet</p>;
}

function StatRenderer({ contribution, facts }: RendererProps) {
  if (facts.length === 0) return <EmptyState />;
  const value = primaryValue(contribution, facts);
  const delta = payloadField(latestPayload(facts), contribution.delta);
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-2xl font-semibold text-foreground">{formatScalar(value)}</span>
      {delta !== undefined && (
        <span className="text-xs text-muted-foreground">{formatScalar(delta)}</span>
      )}
    </div>
  );
}

function tableRows(facts: PluginFact[]): Array<Record<string, unknown>> {
  const payload = latestPayload(facts);
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const rows = payloadField(payload, 'rows');
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function TableRenderer({ facts }: RendererProps) {
  const rows = tableRows(facts);
  if (rows.length === 0) return <EmptyState />;
  const columns = Object.keys(rows[0]);
  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col} className="border-b border-border px-2 py-1 text-left font-medium">
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((col) => (
              <td key={col} className="border-b border-border/50 px-2 py-1">
                {formatScalar(row[col])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimelineRenderer({ contribution, facts }: RendererProps) {
  if (facts.length === 0) return <EmptyState />;
  return (
    <ol className="flex flex-col gap-2">
      {facts.map((fact) => (
        <li key={fact.seq} className="flex items-start gap-2 text-xs">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          <div className="flex flex-col">
            <span className="text-muted-foreground">{fact.createdAt}</span>
            <span className="text-foreground">
              {formatScalar(
                payloadField(fact.payload, contribution.value ?? 'value') ?? fact.payload,
              )}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function BadgeRenderer({ contribution, facts }: RendererProps) {
  if (facts.length === 0) return <EmptyState />;
  return <Badge variant="secondary">{formatScalar(primaryValue(contribution, facts))}</Badge>;
}

function MarkdownRenderer({ contribution, facts }: RendererProps) {
  if (facts.length === 0) return <EmptyState />;
  const value = primaryValue(contribution, facts);
  return <Markdown>{typeof value === 'string' ? value : formatScalar(value)}</Markdown>;
}

function JsonRenderer({ facts }: RendererProps) {
  if (facts.length === 0) return <EmptyState />;
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 text-xs text-foreground">
      {JSON.stringify(latestPayload(facts), null, 2)}
    </pre>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-green-500';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-red-500';
  if (line.startsWith('@@')) return 'text-muted-foreground';
  return 'text-foreground';
}

function DiffRenderer({ contribution, facts }: RendererProps) {
  if (facts.length === 0) return <EmptyState />;
  const value = primaryValue(contribution, facts);
  const text = typeof value === 'string' ? value : formatScalar(value);
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 font-mono text-xs">
      {text.split('\n').map((line, i) => (
        <div key={i} className={diffLineClass(line)}>
          {line}
        </div>
      ))}
    </pre>
  );
}

function LogRenderer({ contribution, facts }: RendererProps) {
  if (facts.length === 0) return <EmptyState />;
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 font-mono text-xs">
      {facts
        .map((fact) => {
          const line = payloadField(fact.payload, contribution.value ?? 'line') ?? fact.payload;
          return `${fact.createdAt}  ${formatScalar(line)}`;
        })
        .join('\n')}
    </pre>
  );
}

const RENDERERS: Record<string, ComponentType<RendererProps>> = {
  stat: StatRenderer,
  table: TableRenderer,
  timeline: TimelineRenderer,
  badge: BadgeRenderer,
  markdown: MarkdownRenderer,
  json: JsonRenderer,
  diff: DiffRenderer,
  log: LogRenderer,
};

/** Looks up a renderer by name. An unknown name degrades to `json`, never a
 *  blank — a plugin naming a future/typo'd renderer still shows its data. */
export function getRenderer(name: string): ComponentType<RendererProps> {
  return RENDERERS[name] ?? RENDERERS.json;
}
