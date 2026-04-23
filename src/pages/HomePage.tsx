import { Composer } from '@/components/Composer';

export default function HomePage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-8 py-12">
          <h1
            className="font-display text-[42px] font-bold leading-none tracking-tight"
            style={{ letterSpacing: '-1px' }}
          >
            ✦ WELCOME BACK
          </h1>
          {/*
           * Sessions inbox slot — filled by a sibling task. Keep the id stable so
           * that task can portal or mount into it without touching this file.
           */}
          <div id="sessions-inbox-slot" data-testid="sessions-inbox-slot" className="mt-8" />
        </div>
      </div>
      <Composer />
    </div>
  );
}
