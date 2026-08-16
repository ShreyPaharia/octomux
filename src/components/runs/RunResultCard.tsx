import type { RunResult } from '@octomux/types';

export const OUTCOME_TONE: Record<RunResult['outcome'], string> = {
  done: 'bg-emerald-500/15 text-emerald-400',
  blocked: 'bg-amber-500/15 text-amber-400',
  failed: 'bg-rose-500/15 text-rose-400',
};

/** Envelope keys rendered explicitly above; everything else is kind-specific `output`. */
const ENVELOPE_KEYS = new Set(['outcome', 'summary', 'links']);

/** camelCase / snake_case / kebab-case → "Title case" for field headings. */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Render an arbitrary value from a kind's `output` schema. Bounded recursion — leaves are scalars,
 * objects and arrays nest. Anything exotic falls back to JSON so this never prints `[object Object]`
 * the way the old `formatResultField` did (spec §7, result-card fidelity).
 */
function RenderValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-soft">—</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="whitespace-pre-wrap">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-soft">none</span>;
    return (
      <ul className="ml-4 list-disc space-y-1">
        {value.map((item, i) => (
          <li key={i}>
            <RenderValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') {
    return (
      <div className="space-y-1">
        {Object.entries(value).map(([k, v]) => (
          <div key={k}>
            <span className="font-medium text-muted-foreground">{humanize(k)}: </span>
            <RenderValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  return <span>{JSON.stringify(value)}</span>;
}

/** Kind-specific output fields (everything past the universal envelope), rendered generically. */
function RunOutputFields({ result }: { result: RunResult }) {
  const entries = Object.entries(result).filter(([k]) => !ENVELOPE_KEYS.has(k));
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-glass-edge pt-3 text-xs text-muted-foreground">
      {entries.map(([k, v]) => (
        <div key={k}>
          <div className="font-semibold text-foreground">{humanize(k)}</div>
          <div className="mt-0.5">
            <RenderValue value={v} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RunResultCard({ result }: { result: RunResult }) {
  return (
    <div className="rounded-2xl border border-glass-edge bg-glass-l2 p-4">
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${OUTCOME_TONE[result.outcome]}`}
      >
        {result.outcome}
      </span>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{result.summary}</p>
      {result.links?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {result.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-glass-edge px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </div>
      ) : null}
      <RunOutputFields result={result} />
    </div>
  );
}
