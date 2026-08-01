import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { FormSelect } from '@/components/ui/form-select';
import { cn } from '@/lib/utils';
import {
  buildCron,
  parseCron,
  describeCron,
  DAY_NAMES,
  FREQUENCY_LABELS,
  type CronFrequency,
  type CronSchedule,
} from './cronBuilder';

interface CronScheduleFieldProps {
  value: string;
  onChange: (cron: string) => void;
  timezone?: string | null;
  /** Prefixes every data-testid so multiple instances stay addressable. */
  testIdPrefix?: string;
}

export function CronScheduleField({
  value,
  onChange,
  timezone,
  testIdPrefix = 'schedule-cron',
}: CronScheduleFieldProps) {
  const parsed = parseCron(value);
  // Frequency is derived from the cron, but "Custom" is a UI-only state the
  // expression itself can't express — hold it locally, resync on external edits.
  const [frequency, setFrequency] = useState<CronFrequency>(parsed.frequency);
  useEffect(() => {
    setFrequency(parseCron(value).frequency);
  }, [value]);

  function emit(patch: Partial<CronSchedule>) {
    onChange(buildCron({ ...parsed, frequency, ...patch }));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1">
        {FREQUENCY_LABELS.map((option) => (
          <button
            key={option.id}
            type="button"
            data-testid={`${testIdPrefix}-${option.id}`}
            aria-pressed={frequency === option.id}
            onClick={() => {
              setFrequency(option.id);
              if (option.id !== 'custom') emit({ frequency: option.id });
            }}
            className={cn(
              'rounded-full px-3 py-1 text-xs transition-colors',
              frequency === option.id
                ? 'bg-glass-l3 font-medium text-foreground'
                : 'text-muted-foreground hover:bg-glass-l2 hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {frequency === 'custom' ? (
        <Input
          data-testid={`${testIdPrefix}-expression`}
          aria-label="Cron expression"
          className="font-mono text-sm"
          placeholder="0 7 * * 1-5"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {frequency === 'weekly' && (
            <>
              <span>On</span>
              <FormSelect
                data-testid={`${testIdPrefix}-day`}
                aria-label="Day of week"
                className="w-auto"
                value={parsed.dayOfWeek}
                onChange={(e) => emit({ dayOfWeek: e.target.value })}
              >
                {DAY_NAMES.map((day, i) => (
                  <option key={day} value={String(i)}>
                    {day}
                  </option>
                ))}
              </FormSelect>
            </>
          )}
          <span>{frequency === 'hourly' ? 'At minute' : 'At'}</span>
          {frequency === 'hourly' ? (
            <Input
              data-testid={`${testIdPrefix}-minute`}
              aria-label="Minute"
              type="number"
              min={0}
              max={59}
              className="w-20"
              value={String(Number(parsed.time.slice(3)))}
              onChange={(e) => emit({ time: `00:${e.target.value.padStart(2, '0')}` })}
            />
          ) : (
            <Input
              data-testid={`${testIdPrefix}-time`}
              aria-label="Time of day"
              type="time"
              className="w-auto"
              value={parsed.time}
              onChange={(e) => e.target.value && emit({ time: e.target.value })}
            />
          )}
        </div>
      )}

      <p className="text-[10px] text-muted-soft">{describeCron(value, timezone)}</p>
    </div>
  );
}
