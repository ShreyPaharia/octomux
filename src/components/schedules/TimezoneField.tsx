/**
 * src/components/schedules/TimezoneField.tsx
 *
 * Searchable timezone combobox backed by Intl.supportedValuesOf('timeZone').
 * Empty value is stored as NULL on the server, which defaults to UTC.
 *
 * Options are labeled "Zone/Name (UTC±H:MM)" using Intl.DateTimeFormat for the
 * current-instant offset. A "Use browser timezone" action fills the current
 * browser zone.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/** All IANA timezone names available in this runtime. Empty array in JSDOM. */
function getSupportedTimezones(): string[] {
  if (typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone');
  }
  return [];
}

/** Format a UTC offset like "+05:30" or "-08:00" from minutes-east. */
function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60)
    .toString()
    .padStart(2, '0');
  const m = (abs % 60).toString().padStart(2, '0');
  return `${sign}${h}:${m}`;
}

/** Build the display label for a timezone: "Zone/Name (UTC±H:MM)". */
function tzLabel(tz: string): string {
  try {
    // Intl.DateTimeFormat resolves the current offset (honors DST).
    const fmt = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' });
    const parts = fmt.formatToParts(new Date());
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    // offsetPart is like "GMT+5:30" or "GMT-8"; normalize to "UTC±H:MM"
    const normalized = offsetPart.replace('GMT', 'UTC');
    return `${tz} (${normalized})`;
  } catch {
    return tz;
  }
}

interface TimezoneFieldProps {
  id?: string;
  value: string; // empty string means UTC (stored as NULL)
  onChange: (tz: string) => void;
  label?: string;
}

export function TimezoneField({
  id = 'schedule-timezone',
  value,
  onChange,
  label = 'Timezone',
}: TimezoneFieldProps) {
  const allZones = useMemo(() => getSupportedTimezones(), []);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // The display string shown in the text input
  const displayValue = useMemo(() => {
    if (!value) return '';
    if (allZones.length === 0) return value;
    return tzLabel(value);
  }, [value, allZones]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return allZones.slice(0, 100); // cap for perf when empty
    const q = filter.toLowerCase();
    return allZones.filter((tz) => tz.toLowerCase().includes(q)).slice(0, 100);
  }, [allZones, filter]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setFilter(e.target.value);
      setOpen(true);
      // If the user clears the field, reset to UTC (empty = NULL)
      if (!e.target.value) onChange('');
    },
    [onChange],
  );

  const handleSelect = useCallback(
    (tz: string) => {
      onChange(tz);
      setFilter('');
      setOpen(false);
    },
    [onChange],
  );

  const handleUseBrowserTz = useCallback(() => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    onChange(browserTz);
    setFilter('');
    setOpen(false);
  }, [onChange]);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Close only if focus leaves the whole container
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setFilter('');
    }
  }, []);

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef} onBlur={handleBlur}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          data-testid="timezone-input"
          autoComplete="off"
          placeholder="UTC"
          value={open ? filter : displayValue}
          onFocus={() => {
            setFilter('');
            setOpen(true);
          }}
          onChange={handleInputChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setFilter('');
            }
            if (e.key === 'Enter' && filtered.length === 1) {
              handleSelect(filtered[0]);
            }
          }}
        />
        {open && (
          <div
            data-testid="timezone-dropdown"
            className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-glass-edge bg-[#0B0C0F] py-1 shadow-lg"
          >
            {/* Browser timezone shortcut */}
            <button
              type="button"
              data-testid="timezone-use-browser"
              className="w-full px-3 py-1.5 text-left text-xs text-[#3B82F6] hover:bg-glass-l1"
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur before click
                handleUseBrowserTz();
              }}
            >
              Use browser timezone
            </button>
            {/* UTC / empty option */}
            <button
              type="button"
              data-testid="timezone-option-utc"
              className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-glass-l1"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect('');
              }}
            >
              UTC (default)
            </button>
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-soft">No matching timezones</p>
            ) : (
              filtered.map((tz) => (
                <button
                  key={tz}
                  type="button"
                  data-testid={`timezone-option-${tz}`}
                  className={`w-full px-3 py-1.5 text-left text-xs hover:bg-glass-l1 ${value === tz ? 'text-[#3B82F6]' : 'text-foreground'}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect(tz);
                  }}
                >
                  {tzLabel(tz)}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {value && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-auto w-fit p-0 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={handleUseBrowserTz}
        >
          Use browser timezone
        </Button>
      )}
    </div>
  );
}

export { formatOffset, tzLabel };
