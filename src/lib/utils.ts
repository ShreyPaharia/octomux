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
