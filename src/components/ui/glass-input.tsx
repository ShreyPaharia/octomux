import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const glassInputVariants = cva(
  'border border-glass-edge bg-[#0B0C0F] font-mono text-white outline-none focus:border-[#3B82F6]',
  {
    variants: {
      fieldSize: {
        md: 'w-full px-3 py-2 text-sm',
        sm: 'px-2 py-1 text-xs',
        narrow: 'w-20 px-2 py-1 text-right text-xs',
      },
    },
    defaultVariants: {
      fieldSize: 'md',
    },
  },
);

function GlassInput({
  className,
  fieldSize,
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> & VariantProps<typeof glassInputVariants>) {
  return <input className={cn(glassInputVariants({ fieldSize }), className)} {...props} />;
}

export { GlassInput, glassInputVariants };
