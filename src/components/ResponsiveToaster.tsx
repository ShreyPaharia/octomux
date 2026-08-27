import { Toaster } from 'sonner';
import { useMediaQuery } from '@/lib/use-media-query';

export function ResponsiveToaster() {
  const isMobile = useMediaQuery('(max-width: 767px)');

  // Top placement everywhere: the composer docks at the bottom of the home
  // page (absolute on md+, in-flow below the scroll area on mobile), and
  // bottom toasts stacked right on top of it, hiding the input.
  return (
    <Toaster
      theme="dark"
      position={isMobile ? 'top-center' : 'top-right'}
      toastOptions={{
        unstyled: true,
      }}
    />
  );
}
