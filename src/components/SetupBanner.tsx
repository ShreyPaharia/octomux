import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';

export function SetupBanner() {
  const [show, setShow] = useState(false);
  const [summary, setSummary] = useState<{ blockers: number; attention: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, setup] = await Promise.all([api.getSettings(), api.getSetupStatus()]);
        if (cancelled) return;
        if (settings.onboardingCompletedAt) {
          setShow(false);
          return;
        }
        const needsAttention = setup.summary.blockerCount > 0 || setup.summary.attentionCount > 0;
        setShow(needsAttention);
        setSummary({
          blockers: setup.summary.blockerCount,
          attention: setup.summary.attentionCount,
        });
      } catch {
        if (!cancelled) setShow(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show || !summary) return null;

  const message =
    summary.blockers > 0
      ? `${summary.blockers} required setup item${summary.blockers === 1 ? '' : 's'} need attention`
      : `${summary.attention} optional setup item${summary.attention === 1 ? '' : 's'} can be configured`;

  return (
    <div
      data-testid="setup-banner"
      className="border-b border-[#FFB800]/30 bg-[#FFB800]/10 px-4 py-2 text-center text-sm text-[#FFB800]"
    >
      {message}.{' '}
      <Link to="/setup" className="font-medium text-[#60a5fa] hover:underline">
        Open Setup
      </Link>
    </div>
  );
}
