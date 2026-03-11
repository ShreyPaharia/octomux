/** Format a UTC datetime string as a relative "X ago" string. */
export function timeAgo(dateStr: string): string {
  const diff = Math.max(0, Date.now() - new Date(dateStr + 'Z').getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Extract the last path segment as the repo display name. */
export function repoName(repoPath: string): string {
  return repoPath.split('/').pop() || repoPath;
}
