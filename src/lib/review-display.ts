/** Strip auto_review task title prefix for display. */
export function displayReviewTitle(title: string): string {
  return title.replace(/^Review:\s*/i, '').trim() || title;
}

/** Parse inbox / DB timestamps (ISO or SQLite `YYYY-MM-DD HH:MM:SS`). */
export function parseActivityDate(dateStr: string): Date {
  if (!dateStr) return new Date(NaN);
  if (dateStr.includes('T')) return new Date(dateStr.endsWith('Z') ? dateStr : `${dateStr}Z`);
  return new Date(`${dateStr.replace(' ', 'T')}Z`);
}

export function riskBadgeClass(risk: string | undefined): string {
  switch (risk?.toLowerCase()) {
    case 'high':
      return 'border-destructive/40 bg-destructive/15 text-destructive';
    case 'medium':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-400';
    case 'low':
      return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400';
    default:
      return '';
  }
}
