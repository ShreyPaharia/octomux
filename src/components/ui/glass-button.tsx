import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const glassButtonVariants = cva('focus-ring text-xs disabled:opacity-40', {
  variants: {
    variant: {
      primary: 'bg-[#3B82F6] text-white hover:bg-[#2563eb] active:bg-[#1d4ed8]',
      cancel: 'text-[#b5b5bd] hover:text-white',
      destructive: 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800',
      link: 'text-[#3B82F6] hover:text-[#60a5fa] active:text-[#93c5fd]',
    },
    size: {
      dialog: 'px-3 py-1.5',
      inline: 'px-3 py-1',
    },
  },
  defaultVariants: {
    variant: 'primary',
    size: 'dialog',
  },
});

function GlassButton({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof glassButtonVariants>) {
  return (
    <button
      type={type}
      className={cn(glassButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { GlassButton, glassButtonVariants };
