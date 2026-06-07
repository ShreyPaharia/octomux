import { Toaster } from 'sonner';
import { useMediaQuery } from '@/lib/use-media-query';

export function ResponsiveToaster() {
  const isMobile = useMediaQuery('(max-width: 767px)');

  return (
    <Toaster
      theme="dark"
      position={isMobile ? 'top-center' : 'bottom-right'}
      toastOptions={{
        unstyled: true,
      }}
    />
  );
}
