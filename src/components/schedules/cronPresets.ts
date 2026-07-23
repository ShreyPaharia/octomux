export type CronPresetId = 'weekday' | 'daily' | 'weekly' | 'hourly' | 'custom';

export interface CronPreset {
  id: CronPresetId;
  label: string;
  cron: string;
  summary: string;
}

export const CRON_PRESETS: CronPreset[] = [
  {
    id: 'weekday',
    label: 'Every weekday',
    cron: '0 9 * * 1-5',
    summary: 'Every weekday at 09:00',
  },
  {
    id: 'daily',
    label: 'Daily',
    cron: '0 9 * * *',
    summary: 'Every day at 09:00',
  },
  {
    id: 'weekly',
    label: 'Weekly',
    cron: '0 9 * * 1',
    summary: 'Every Monday at 09:00',
  },
  {
    id: 'hourly',
    label: 'Hourly',
    cron: '0 * * * *',
    summary: 'Every hour at :00',
  },
  {
    id: 'custom',
    label: 'Custom',
    cron: '',
    summary: '',
  },
];

export function cronPresetFromExpression(cron: string): CronPresetId {
  const trimmed = cron.trim();
  const match = CRON_PRESETS.find((p) => p.id !== 'custom' && p.cron === trimmed);
  return match?.id ?? 'custom';
}

export function cronSummary(cron: string): string {
  const trimmed = cron.trim();
  if (!trimmed) return '';
  const preset = CRON_PRESETS.find((p) => p.id !== 'custom' && p.cron === trimmed);
  if (preset) return preset.summary;
  return `Custom: ${trimmed}`;
}
