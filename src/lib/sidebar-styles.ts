import { cn } from '@/lib/utils';

/** Expanded sidebar nav link (Home, Tasks, …). */
export function sidebarNavLinkClass(active: boolean): string {
  return cn(
    'focus-ring flex items-center gap-2.5 rounded-[10px] py-2 text-[13px] font-medium transition-all duration-150 ease-out',
    active
      ? 'border-l-2 border-primary bg-primary/15 pl-2 pr-2.5 text-primary'
      : 'border-l-2 border-transparent px-2.5 text-white/65 hover:bg-white/5 hover:text-foreground',
  );
}

/** Collapsed rail nav tile. */
export function sidebarNavTileClass(active: boolean): string {
  return cn(
    'focus-ring relative flex size-9 items-center justify-center rounded-[10px] transition-all duration-150 ease-out',
    active
      ? 'border border-primary/40 bg-primary/15'
      : 'border border-transparent hover:bg-white/5',
  );
}

/** Secondary nav link (Workspaces under More). */
export function sidebarSecondaryLinkClass(active: boolean): string {
  return cn(
    'focus-ring flex items-center gap-2.5 rounded-[10px] py-2 text-xs font-medium transition-all duration-150 ease-out',
    active
      ? 'border-l-2 border-primary bg-primary/15 pl-2 pr-2.5 text-primary'
      : 'border-l-2 border-transparent px-2.5 text-white/65 hover:bg-white/5 hover:text-foreground',
  );
}

export function sidebarIconColor(active: boolean): string {
  return active ? '#3B82F6' : 'rgba(255,255,255,0.65)';
}
