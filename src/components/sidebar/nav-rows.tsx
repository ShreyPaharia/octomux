import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  sidebarIconColor,
  sidebarNavLinkClass,
  sidebarNavTileClass,
  sidebarSecondaryLinkClass,
} from '@/lib/sidebar-styles';
import { FOCUS_RING } from './constants';
import type { NavIcon } from './glyphs';
import { MORE_ITEMS } from './nav-items';

// ─── Nav row (expanded) ────────────────────────────────────────────────────

export function ExpandedNavRow({
  to,
  Icon,
  label,
  isActive,
}: {
  to: string;
  Icon: NavIcon;
  label: string;
  isActive: boolean;
}) {
  const pretty = label.charAt(0) + label.slice(1).toLowerCase();

  return (
    <div className="px-3 py-0.5">
      <Link
        to={to}
        aria-label={pretty}
        aria-current={isActive ? 'page' : undefined}
        data-active={isActive || undefined}
        data-testid={`sidebar-nav-${label.toLowerCase()}`}
        className={sidebarNavLinkClass(isActive)}
      >
        <Icon color={sidebarIconColor(isActive)} />
        <span className="truncate">{label}</span>
      </Link>
    </div>
  );
}

// ─── Nav tile (collapsed rail) ─────────────────────────────────────────────

export function CollapsedNavTile({
  to,
  Icon,
  isActive,
  tooltip,
  ariaLabel,
}: {
  to: string;
  Icon: NavIcon;
  isActive: boolean;
  tooltip: string;
  ariaLabel: string;
}) {
  return (
    <div className="flex justify-center py-1">
      <Link
        to={to}
        title={tooltip}
        aria-label={ariaLabel}
        aria-current={isActive ? 'page' : undefined}
        data-active={isActive || undefined}
        className={sidebarNavTileClass(isActive)}
      >
        <Icon color={sidebarIconColor(isActive)} />
      </Link>
    </div>
  );
}

// ─── More (collapsible secondary nav) ──────────────────────────────────────

const MORE_STORAGE_KEY = 'octomux:sidebar:more-open';

export function MoreSection({ collapsed, activePath }: { collapsed: boolean; activePath: string }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MORE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MORE_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <div style={{ paddingBottom: 12 }}>
        {MORE_ITEMS.map(({ key, to, Icon, label }) => {
          const isActive = activePath === to || activePath.startsWith(to + '/');
          return (
            <CollapsedNavTile
              key={key}
              to={to}
              Icon={Icon}
              isActive={isActive}
              tooltip={label.toLowerCase()}
              ariaLabel={label.toLowerCase()}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 12 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-testid="sidebar-more-toggle"
        className={`flex w-full items-center justify-between text-[10px] font-medium tracking-wide text-muted-soft hover:text-white rounded-[4px] ${FOCUS_RING}`}
        style={{ padding: '0 20px 8px' }}
      >
        <span>More</span>
        <span
          style={{
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 120ms',
            display: 'inline-block',
          }}
        >
          ⌄
        </span>
      </button>
      {open &&
        MORE_ITEMS.map(({ key, to, Icon, label }) => {
          const isActive = activePath === to || activePath.startsWith(to + '/');
          return (
            <div key={key} className="px-3 py-0.5">
              <Link
                to={to}
                aria-current={isActive ? 'page' : undefined}
                data-active={isActive || undefined}
                data-testid={`sidebar-more-${key}`}
                className={sidebarSecondaryLinkClass(isActive)}
              >
                <Icon color={sidebarIconColor(isActive)} />
                {label}
              </Link>
            </div>
          );
        })}
    </div>
  );
}
