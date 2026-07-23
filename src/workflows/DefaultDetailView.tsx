import { useEffect, useState } from 'react';
import { GlassPanel } from '@/components/ui/glass-panel';
import { PageHeader } from '@/components/layout/page-header';

interface JsonSchemaProperty {
  type?: string;
  enum?: string[];
}

interface JsonSchemaLike {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export interface DefaultDetailViewProps {
  id: string;
  displayName: string;
  outputSchema: JsonSchemaLike;
  getItem: (id: string) => Promise<Record<string, unknown>>;
}

/** Generic detail renderer for any workflow kind that registers an `output` JSON Schema but no
 * custom DetailView — renders one row per schema property, in schema-declaration order. */
export function DefaultDetailView({
  id,
  displayName,
  outputSchema,
  getItem,
}: DefaultDetailViewProps) {
  const [item, setItem] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getItem(id)
      .then((result) => {
        if (!cancelled) setItem(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, getItem]);

  const fields = Object.keys(outputSchema.properties ?? {});

  return (
    <div className="flex h-full min-h-0 flex-col p-6" data-testid="default-detail-view">
      <PageHeader title={displayName} />
      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      {!error && !item && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
      {item && (
        <GlassPanel level={2} className="mt-4 flex flex-col gap-2 rounded-2xl p-4">
          {fields.map((field) => (
            <div
              key={field}
              className="flex justify-between gap-4 text-sm"
              data-testid={`field-${field}`}
            >
              <span className="font-medium text-muted-foreground">{field}</span>
              <span className="text-right text-foreground">{formatValue(item[field])}</span>
            </div>
          ))}
        </GlassPanel>
      )}
    </div>
  );
}
