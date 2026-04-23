import { useSearchParams } from 'react-router-dom';

export default function HomePage() {
  // Pre-fill params for the future chip composer. Sibling task will wire the composer up.
  useSearchParams();

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-8 py-12">
        <h1
          className="font-display text-[42px] font-bold leading-none tracking-tight"
          style={{ letterSpacing: '-1px' }}
        >
          ✦ WELCOME BACK
        </h1>
        <p className="mt-4 text-sm text-[#8a8a8a]">Composer and sessions inbox coming soon.</p>
      </div>
    </div>
  );
}
