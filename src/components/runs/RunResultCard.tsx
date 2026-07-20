import type { RunResult } from '@octomux/types';

const OUTCOME_TONE: Record<RunResult['outcome'], string> = {
  done: 'bg-emerald-500/15 text-emerald-400',
  blocked: 'bg-amber-500/15 text-amber-400',
  failed: 'bg-rose-500/15 text-rose-400',
};

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
    </div>
  );
}
