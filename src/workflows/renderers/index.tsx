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
import type { RecordEnvelope, UiContribution } from '@/lib/plugin-ui';

export interface RendererProps {
  contribution: UiContribution;
  records: RecordEnvelope[];
}

function latestPayload(records: RecordEnvelope[]): unknown {
  return records.length > 0 ? records[records.length - 1].payload : undefined;
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
function primaryValue(contribution: UiContribution, records: RecordEnvelope[]): unknown {
  const payload = latestPayload(records);
  if (typeof payload === 'object' && payload !== null) {
    return payloadField(payload, contribution.value ?? 'value');
  }
  return payload;
}

function EmptyState() {
  return <p className="text-xs text-muted-foreground">No data yet</p>;
}

function StatRenderer({ contribution, records }: RendererProps) {
  if (records.length === 0) return <EmptyState />;
  const value = primaryValue(contribution, records);
  const delta = payloadField(latestPayload(records), contribution.delta);
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-2xl font-semibold text-foreground">{formatScalar(value)}</span>
      {delta !== undefined && (
        <span className="text-xs text-muted-foreground">{formatScalar(delta)}</span>
      )}
    </div>
  );
}

function tableRows(records: RecordEnvelope[]): Array<Record<string, unknown>> {
  const payload = latestPayload(records);
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const rows = payloadField(payload, 'rows');
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  // Neither shape matched, so fall back to one row PER record — what a
  // durable store's board wants: reading only the last row would show a
  // 2,000-record board as a single row.
  // Mirrors `tableRows` in `server/surfaces/text.ts` — keep the two in step.
  return records.every((r) => typeof r.payload === 'object' && r.payload !== null)
    ? records.map((r) => r.payload as Record<string, unknown>)
    : [];
}

function TableRenderer({ records }: RendererProps) {
  const rows = tableRows(records);
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

function TimelineRenderer({ contribution, records }: RendererProps) {
  if (records.length === 0) return <EmptyState />;
  return (
    <ol className="flex flex-col gap-2">
      {records.map((record) => (
        <li key={record.seq} className="flex items-start gap-2 text-xs">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          <div className="flex flex-col">
            <span className="text-muted-foreground">{record.createdAt}</span>
            <span className="text-foreground">
              {formatScalar(
                payloadField(record.payload, contribution.value ?? 'value') ?? record.payload,
              )}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function BadgeRenderer({ contribution, records }: RendererProps) {
  if (records.length === 0) return <EmptyState />;
  return <Badge variant="secondary">{formatScalar(primaryValue(contribution, records))}</Badge>;
}

function MarkdownRenderer({ contribution, records }: RendererProps) {
  if (records.length === 0) return <EmptyState />;
  const value = primaryValue(contribution, records);
  return <Markdown>{typeof value === 'string' ? value : formatScalar(value)}</Markdown>;
}

function JsonRenderer({ records }: RendererProps) {
  if (records.length === 0) return <EmptyState />;
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 text-xs text-foreground">
      {JSON.stringify(latestPayload(records), null, 2)}
    </pre>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-green-500';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-red-500';
  if (line.startsWith('@@')) return 'text-muted-foreground';
  return 'text-foreground';
}

function DiffRenderer({ contribution, records }: RendererProps) {
  if (records.length === 0) return <EmptyState />;
  const value = primaryValue(contribution, records);
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

function LogRenderer({ contribution, records }: RendererProps) {
  if (records.length === 0) return <EmptyState />;
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 font-mono text-xs">
      {records
        .map((record) => {
          const line = payloadField(record.payload, contribution.value ?? 'line') ?? record.payload;
          return `${record.createdAt}  ${formatScalar(line)}`;
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
