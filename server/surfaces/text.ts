/**
 * server/surfaces/text.ts
 *
 * One plain-text renderer shared by every server-rendered core surface
 * (`cli`, `slack`, `telegram`). Switches on `panel.renderer` — never
 * `panel.as` — because `renderer` is what `SurfaceDefinition.renderers`
 * guarantees this surface can draw (see the `SurfaceDefinition` doc in
 * `@octomux/plugin-api`); `as` is only what the binding originally asked for.
 *
 * Mirrors the value-resolution rules of the client renderer registry
 * (`src/workflows/renderers/index.tsx`) so the same panel reads the same way
 * whether it lands in a browser or a Slack DM: an object payload reads its
 * `panel.value ?? 'value'` key, a scalar payload is used as-is.
 */
import type { Fact, SurfacePanel } from '@octomux/plugin-api';

function latestPayload(facts: Fact[]): unknown {
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

function primaryValue(panel: SurfacePanel): unknown {
  const payload = latestPayload(panel.facts);
  if (typeof payload === 'object' && payload !== null) {
    return payloadField(payload, panel.value ?? 'value');
  }
  return payload;
}

function renderStat(panel: SurfacePanel): string {
  const value = formatScalar(primaryValue(panel));
  const delta = payloadField(latestPayload(panel.facts), panel.delta);
  return delta !== undefined ? `${value} (${formatScalar(delta)})` : value;
}

function renderBadge(panel: SurfacePanel): string {
  return `[${formatScalar(primaryValue(panel))}]`;
}

function renderMarkdown(panel: SurfacePanel): string {
  const value = primaryValue(panel);
  return typeof value === 'string' ? value : formatScalar(value);
}

function renderJson(panel: SurfacePanel): string {
  return '```json\n' + JSON.stringify(latestPayload(panel.facts), null, 2) + '\n```';
}

function tableRows(facts: Fact[]): Array<Record<string, unknown>> {
  const payload = latestPayload(facts);
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const rows = payloadField(payload, 'rows');
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  // Neither shape matched, so fall back to one row PER entry. This is what a
  // collection-bound panel wants (SHR-279): its records arrive here as facts,
  // one record each, and reading only the last one would show a 2,000-record
  // board as a single row. For a fact-bound panel this only fires where the
  // old code rendered nothing at all, so it never changes an existing table.
  return facts.every((f) => typeof f.payload === 'object' && f.payload !== null)
    ? facts.map((f) => f.payload as Record<string, unknown>)
    : [];
}

function renderTable(panel: SurfacePanel): string {
  const rows = tableRows(panel.facts);
  if (rows.length === 0) return formatScalar(undefined);
  const columns = Object.keys(rows[0]);
  const lines = [columns.join(' | '), columns.map(() => '---').join(' | ')];
  for (const row of rows) {
    lines.push(columns.map((c) => formatScalar(row[c])).join(' | '));
  }
  return lines.join('\n');
}

function renderTimeline(panel: SurfacePanel): string {
  return panel.facts
    .map((fact) => {
      const value = payloadField(fact.payload, panel.value ?? 'value') ?? fact.payload;
      return `${fact.createdAt}  ${formatScalar(value)}`;
    })
    .join('\n');
}

function renderLog(panel: SurfacePanel): string {
  return panel.facts
    .map((fact) => {
      const line = payloadField(fact.payload, panel.value ?? 'line') ?? fact.payload;
      return `${fact.createdAt}  ${formatScalar(line)}`;
    })
    .join('\n');
}

function renderDiff(panel: SurfacePanel): string {
  const value = primaryValue(panel);
  const text = typeof value === 'string' ? value : formatScalar(value);
  return '```diff\n' + text + '\n```';
}

const RENDERERS: Record<string, (panel: SurfacePanel) => string> = {
  stat: renderStat,
  badge: renderBadge,
  markdown: renderMarkdown,
  json: renderJson,
  table: renderTable,
  timeline: renderTimeline,
  log: renderLog,
  diff: renderDiff,
};

/**
 * Plain-text render for one panel. `undefined` means "nothing to show" —
 * `panel.facts` is empty — and the panel is omitted, never rendered blank.
 * Prefixes `panel.title` when set. An unrecognized `panel.renderer` (should
 * not happen — `resolveRenderer` only ever hands back a name the surface
 * declared or its fallback) degrades to the json renderer rather than throw.
 */
export function renderPanelText(panel: SurfacePanel): string | undefined {
  if (panel.facts.length === 0) return undefined;
  const render = RENDERERS[panel.renderer] ?? renderJson;
  const body = render(panel);
  return panel.title ? `${panel.title}\n${body}` : body;
}
