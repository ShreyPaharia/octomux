import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormSelect } from '@/components/ui/form-select';
import {
  CRON_PRESETS,
  cronPresetFromExpression,
  cronSummary,
  type CronPresetId,
} from './cronPresets';

interface CronPresetFieldProps {
  value: string;
  onChange: (cron: string) => void;
  id?: string;
  presetTestId?: string;
  customTestId?: string;
}

export function CronPresetField({
  value,
  onChange,
  id = 'schedule-cron',
  presetTestId = 'schedule-cron-preset',
  customTestId = 'schedule-cron-custom',
}: CronPresetFieldProps) {
  const [presetId, setPresetId] = useState<CronPresetId>(() => cronPresetFromExpression(value));

  useEffect(() => {
    setPresetId(cronPresetFromExpression(value));
  }, [value]);

  const summary = cronSummary(value);
  const isCustom = presetId === 'custom';

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Schedule</Label>
      <FormSelect
        id={id}
        data-testid={presetTestId}
        value={presetId}
        onChange={(e) => {
          const next = e.target.value as CronPresetId;
          setPresetId(next);
          if (next !== 'custom') {
            const preset = CRON_PRESETS.find((p) => p.id === next);
            if (preset) onChange(preset.cron);
          }
        }}
      >
        {CRON_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </FormSelect>
      {isCustom ? (
        <Input
          data-testid={customTestId}
          className="font-mono text-sm"
          placeholder="0 7 * * 1-5"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
      {summary ? <p className="text-[10px] text-muted-soft">{summary}</p> : null}
    </div>
  );
}
