import { Button } from '../ui/button';

export interface CommentFilters {
  severity: Array<'nit' | 'suggestion' | 'issue' | 'critical'>;
  bucket: Array<'actionable' | 'informational'>;
  kind: Array<'comment' | 'suggestion'>;
  showResolved: boolean;
}

interface ReviewFiltersProps {
  filters: CommentFilters;
  onChange: (filters: CommentFilters) => void;
}

function toggle<T>(arr: T[], val: T): T[] {
  return arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
}

const SEVERITIES: Array<'nit' | 'suggestion' | 'issue' | 'critical'> = [
  'critical',
  'issue',
  'suggestion',
  'nit',
];
const BUCKETS: Array<'actionable' | 'informational'> = ['actionable', 'informational'];
const KINDS: Array<'comment' | 'suggestion'> = ['comment', 'suggestion'];

export function ReviewFilters({ filters, onChange }: ReviewFiltersProps) {
  function btnVariant(active: boolean) {
    return active ? ('default' as const) : ('outline' as const);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Filter:</span>

      {/* Severity */}
      {SEVERITIES.map((s) => (
        <Button
          key={s}
          size="xs"
          variant={btnVariant(filters.severity.includes(s))}
          onClick={() => onChange({ ...filters, severity: toggle(filters.severity, s) })}
        >
          {s}
        </Button>
      ))}

      <span className="mx-1 text-glass-edge">|</span>

      {/* Bucket */}
      {BUCKETS.map((b) => (
        <Button
          key={b}
          size="xs"
          variant={btnVariant(filters.bucket.includes(b))}
          onClick={() => onChange({ ...filters, bucket: toggle(filters.bucket, b) })}
        >
          {b}
        </Button>
      ))}

      <span className="mx-1 text-glass-edge">|</span>

      {/* Kind */}
      {KINDS.map((k) => (
        <Button
          key={k}
          size="xs"
          variant={btnVariant(filters.kind.includes(k))}
          onClick={() => onChange({ ...filters, kind: toggle(filters.kind, k) })}
        >
          {k}
        </Button>
      ))}

      <span className="mx-1 text-glass-edge">|</span>

      <Button
        size="xs"
        variant={btnVariant(filters.showResolved)}
        onClick={() => onChange({ ...filters, showResolved: !filters.showResolved })}
      >
        {filters.showResolved ? 'hide resolved' : 'show resolved'}
      </Button>

      {/* Clear button */}
      {(filters.severity.length > 0 ||
        filters.bucket.length > 0 ||
        filters.kind.length > 0 ||
        filters.showResolved) && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            onChange({ severity: [], bucket: [], kind: [], showResolved: false })
          }
        >
          Clear
        </Button>
      )}
    </div>
  );
}
