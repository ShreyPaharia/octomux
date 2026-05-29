import type { Walkthrough, WalkthroughFile } from '@/components/review/WalkthroughHeader';

export const OTHER_GROUP_NAME = 'Other';

export interface RenderGroup {
  name: string;
  summary?: string;
  files: WalkthroughFile[];
}

export function buildGroups(files: string[], walkthrough: Walkthrough | null): RenderGroup[] {
  const diffSet = new Set(files);
  const claimed = new Set<string>();
  const groups: RenderGroup[] = [];

  for (const g of walkthrough?.groups ?? []) {
    const present = (g.files ?? []).filter((f) => diffSet.has(f.path));
    if (present.length === 0) continue;
    for (const f of present) claimed.add(f.path);
    groups.push({ name: g.name, summary: g.summary, files: present });
  }

  const orphans = files.filter((p) => !claimed.has(p));
  if (orphans.length > 0) {
    groups.push({
      name: OTHER_GROUP_NAME,
      files: orphans.map((path) => ({ path })),
    });
  }

  return groups;
}

export function orderedPathsFromGroups(groups: RenderGroup[]): string[] {
  return groups.flatMap((g) => g.files.map((f) => f.path));
}
