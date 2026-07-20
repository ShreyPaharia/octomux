import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
}

interface SchemaConfigFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

function fieldLabel(key: string, prop: SchemaProperty): string {
  return prop.title ?? key;
}

export function defaultsFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

export function SchemaConfigForm({ schema, value, onChange }: SchemaConfigFormProps) {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
  const entries = Object.entries(properties);
  if (entries.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {entries.map(([key, prop]) => {
        const label = fieldLabel(key, prop);
        const current = value[key];

        if (prop.type === 'integer' || prop.type === 'number') {
          return (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={`config-${key}`}>{label}</Label>
              <Input
                id={`config-${key}`}
                data-testid={`schedule-config-${key}`}
                type="number"
                min={prop.minimum}
                value={current === undefined ? '' : String(current)}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange({
                    ...value,
                    [key]: raw === '' ? undefined : Number.parseInt(raw, 10),
                  });
                }}
              />
              {prop.description ? (
                <p className="text-[10px] text-muted-soft">{prop.description}</p>
              ) : null}
            </div>
          );
        }

        return (
          <div key={key} className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`config-${key}`}>{label}</Label>
            <Input
              id={`config-${key}`}
              data-testid={`schedule-config-${key}`}
              className={key === 'verify' || key === 'logCommand' ? 'font-mono text-sm' : undefined}
              value={typeof current === 'string' ? current : ''}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
            />
            {prop.description ? (
              <p className="text-[10px] text-muted-soft">{prop.description}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
