import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Last path segment of a repo path, falling back to the full path. */
export function repoName(repoPath: string | null | undefined): string {
  if (!repoPath) return '—';
  return repoPath.split('/').filter(Boolean).pop() || repoPath;
}

/**
 * Returns the basename (last segment) of a file-system path.
 * Strips trailing slashes before splitting.
 * Falls back to the full path if the path has no segments.
 */
export function repoBasename(path: string): string {
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || path;
}
