export interface HunkRange {
  modifiedStartLineNumber: number;
}

export function findHunkLine(
  changes: readonly HunkRange[] | null | undefined,
  currentLine: number,
  direction: 1 | -1,
): number | null {
  if (!changes || changes.length === 0) return null;

  const sorted = [...changes].sort(
    (a, b) => a.modifiedStartLineNumber - b.modifiedStartLineNumber,
  );

  if (direction === 1) {
    for (const c of sorted) {
      if (c.modifiedStartLineNumber > currentLine) return c.modifiedStartLineNumber;
    }
    return sorted[0].modifiedStartLineNumber;
  }

  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].modifiedStartLineNumber < currentLine) return sorted[i].modifiedStartLineNumber;
  }
  return sorted[sorted.length - 1].modifiedStartLineNumber;
}
