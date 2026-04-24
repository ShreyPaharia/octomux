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

export function reviewedKey(taskId: string, filePath: string): string {
  return `octomux:reviewed:${taskId}:${filePath}`;
}

export function getReviewed(taskId: string, filePath: string): boolean {
  try {
    return localStorage.getItem(reviewedKey(taskId, filePath)) === 'true';
  } catch {
    return false;
  }
}

export function setReviewed(taskId: string, filePath: string, value: boolean): void {
  try {
    const k = reviewedKey(taskId, filePath);
    if (value) localStorage.setItem(k, 'true');
    else localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
