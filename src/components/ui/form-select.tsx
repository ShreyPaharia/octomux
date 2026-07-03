import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const formSelectVariants = cva(
  'focus-ring border border-glass-edge bg-[#0B0C0F] text-white outline-none focus:border-[#3B82F6]',
  {
    variants: {
      fieldSize: {
        sm: 'px-3 py-1 text-xs',
        md: 'px-3 py-2 text-sm',
      },
    },
    defaultVariants: {
      fieldSize: 'sm',
    },
  },
);

function FormSelect({
  className,
  fieldSize,
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & VariantProps<typeof formSelectVariants>) {
  return <select className={cn(formSelectVariants({ fieldSize }), className)} {...props} />;
}

export { FormSelect, formSelectVariants };
