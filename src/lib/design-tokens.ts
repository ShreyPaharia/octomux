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

/** Diff file tree — active file row (matches sidebar nav accent). */
export const DIFF_TREE_ACTIVE = 'rounded-md border border-primary/40 bg-primary/15 text-primary';

/** Diff file tree — default row hover. */
export const DIFF_TREE_ROW =
  'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-xs hover:bg-glass-l2/60';

/** Diff review progress badge in the main pane toolbar. */
export const DIFF_REVIEW_BADGE =
  'inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/15 px-2 py-0.5 font-mono text-[11px] text-primary';

/** Active filter pill in the comments side panel. */
export const DIFF_FILTER_ACTIVE = 'border-primary/40 bg-primary/15 text-primary';
