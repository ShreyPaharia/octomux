import { useEffect, useState } from 'react';

interface Props {
  deletedAt: string;
  graceHours: number;
}

export function TrashCountdown({ deletedAt, graceHours }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const expiry = new Date(deletedAt).getTime() + graceHours * 60 * 60 * 1000;
  const ms = expiry - now;

  if (ms <= 0) {
    return <span className="text-destructive text-xs">purging soon</span>;
  }

  const hrs = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const label = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  const danger = hrs < 1;

  return (
    <span className={`text-xs ${danger ? 'text-destructive' : 'text-muted-soft'}`}>
      purges in {label}
    </span>
  );
}
