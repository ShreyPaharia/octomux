import { useEffect, useState } from 'react';
import { subscribeConnectionState } from '@/lib/event-source';
import { CloudOffIcon } from './icons';

const SHOW_AFTER_MS = 10_000;

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeConnectionState((connected) => {
      if (connected) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        setOffline(false);
      } else {
        if (timer) return;
        timer = setTimeout(() => {
          setOffline(true);
          timer = null;
        }, SHOW_AFTER_MS);
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="status"
      data-testid="global-offline-banner"
      className="bg-glass-l1 glass-blur-l1 flex items-center justify-center gap-2 border-b border-[#FFB80033] bg-[#FFB80014] px-4 py-1.5"
    >
      <CloudOffIcon size={12} className="text-[#FFB800]" />
      <span className="text-[11px] font-medium text-[#FFB800]">
        You&rsquo;re offline — reconnecting…
      </span>
    </div>
  );
}
