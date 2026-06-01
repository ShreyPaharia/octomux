/**
 * Formats an elapsed duration (in milliseconds) into a compact human label.
 *
 *   <1m  -> "Ns"
 *   <1h  -> "Nm Ss"
 *   >=1h -> "Nh Nm"
 *
 * Negative inputs clamp to 0s.
 */
export function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;

  const totalMins = Math.floor(totalSecs / 60);
  if (totalMins < 60) return `${totalMins}m ${totalSecs % 60}s`;

  const hrs = Math.floor(totalMins / 60);
  return `${hrs}h ${totalMins % 60}m`;
}
