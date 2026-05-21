import type { CSSProperties } from 'react';

/** Standard separator between stacked rows in settings-style panels. */
export const ROW_DIVIDER: CSSProperties = {
  borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
};

export const SECTION_HEADER_DIVIDER: CSSProperties = {
  ...ROW_DIVIDER,
  padding: '18px 0',
};

/** Active settings nav item — left accent bar + tint (matches sidebar active row). */
export const SETTINGS_NAV_ACTIVE_STYLE: CSSProperties = {
  backgroundColor: 'rgba(59, 130, 246, 0.12)',
  boxShadow: 'inset 2px 0 0 0 var(--primary)',
};
