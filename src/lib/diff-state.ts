export function diffExpandedKey(taskId: string, filePath: string): string {
  return `octomux:diff-expanded:${taskId}:${filePath}`;
}

export function getDiffExpanded(taskId: string, filePath: string): boolean {
  try {
    return localStorage.getItem(diffExpandedKey(taskId, filePath)) === 'true';
  } catch {
    return false;
  }
}

export function setDiffExpanded(taskId: string, filePath: string, value: boolean): void {
  try {
    localStorage.setItem(diffExpandedKey(taskId, filePath), String(value));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — degrade silently
  }
}
