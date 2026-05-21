import type { ReactNode } from 'react';

import { ROW_DIVIDER } from '@/lib/design-tokens';

export interface SettingRowProps {
  label: string;
  description?: string;
  children: ReactNode;
  lastRow?: boolean;
}

export function SettingRow({ label, description, children, lastRow = false }: SettingRowProps) {
  return (
    <div
      className="flex items-center justify-between py-3"
      style={lastRow ? undefined : ROW_DIVIDER}
    >
      <div>
        <span className="text-sm text-foreground">{label}</span>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}
