import { Composer } from '@/components/Composer';
import { SessionsInbox } from '@/components/SessionsInbox';

export default function HomePage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-8 py-12">
          <div className="flex flex-col gap-2">
            <span
              data-testid="page-eyebrow"
              className="font-mono text-[11px] font-bold text-[#B5B5BD]"
              style={{ letterSpacing: '1.5px' }}
            >
              // INBOX
            </span>
            <h1
              className="font-display text-[32px] font-bold leading-[1.1] tracking-tight"
              style={{ letterSpacing: '-0.5px' }}
            >
              Welcome back
            </h1>
          </div>
          <div id="sessions-inbox-slot" data-testid="sessions-inbox-slot" className="mt-8">
            <SessionsInbox />
          </div>
        </div>
      </div>
      <Composer />
    </div>
  );
}
