import { useEffect, useRef } from 'react';
import type { Task } from '../../server/types';

const NORMAL_TITLE = 'octomux';
const NORMAL_FAVICON = '/logo.png';

function countAttention(tasks: Task[]): number {
  return tasks.filter((t) => {
    const effective = t.derived_status ?? t.status;
    return effective === 'error' || effective === 'needs_attention';
  }).length;
}

/** Canvas-generate a 32x32 favicon with a red notification dot in the top-right corner. */
function createAlertFavicon(logo: HTMLImageElement): string {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(logo, 0, 0, size, size);

  // Red dot — top-right
  const dotRadius = 7;
  const cx = size - dotRadius - 1;
  const cy = dotRadius + 1;
  ctx.beginPath();
  ctx.arc(cx, cy, dotRadius, 0, 2 * Math.PI);
  ctx.fillStyle = '#ef4444';
  ctx.fill();
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 2;
  ctx.stroke();

  return canvas.toDataURL('image/png');
}

function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.href !== href) {
    link.href = href;
  }
}

/**
 * Updates the browser tab title and favicon based on how many tasks need attention.
 * Call once at the app root with the full task list.
 */
export function useAttentionIndicator(tasks: Task[]) {
  const alertFaviconRef = useRef<string | null>(null);

  // Pre-render the alert favicon once
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      alertFaviconRef.current = createAlertFavicon(img);
    };
    img.src = NORMAL_FAVICON;
  }, []);

  useEffect(() => {
    const count = countAttention(tasks);

    // Update title
    document.title = count > 0 ? `(${count}) ${NORMAL_TITLE}` : NORMAL_TITLE;

    // Update favicon
    if (count > 0 && alertFaviconRef.current) {
      setFavicon(alertFaviconRef.current);
    } else {
      setFavicon(NORMAL_FAVICON);
    }
  }, [tasks]);

  // Reset on unmount
  useEffect(() => {
    return () => {
      document.title = NORMAL_TITLE;
      setFavicon(NORMAL_FAVICON);
    };
  }, []);
}
