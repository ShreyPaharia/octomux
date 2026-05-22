import { type FormEvent, type KeyboardEvent, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

export interface ComposerInputPanelProps {
  prompt: string;
  placeholder: string;
  blockedReason: string | null;
  canSubmit: boolean;
  submitting: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onPromptChange: (value: string) => void;
  onSubmit: (e?: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function ComposerInputPanel({
  prompt,
  placeholder,
  blockedReason,
  canSubmit,
  submitting,
  textareaRef,
  onPromptChange,
  onSubmit,
  onKeyDown,
}: ComposerInputPanelProps) {
  return (
    <form onSubmit={onSubmit} data-testid="composer-input-panel">
      <InputGroup
        className={cn(
          'composer-prompt-well h-auto min-w-0 flex-col',
          'border-glass-edge bg-transparent shadow-none',
          'has-disabled:opacity-100 dark:bg-transparent',
          'has-[[data-slot=input-group-control]:focus-visible]:border-glass-edge-strong',
          'has-[[data-slot=input-group-control]:focus-visible]:ring-3',
          'has-[[data-slot=input-group-control]:focus-visible]:ring-ring/40',
        )}
      >
        <InputGroupTextarea
          ref={textareaRef}
          data-testid="composer-prompt"
          rows={1}
          placeholder={placeholder}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Task prompt"
          className={cn(
            'field-sizing-content w-full min-h-[4.5rem] max-h-[min(17.5rem,40vh)]',
            'resize-none overflow-y-auto px-3 py-2.5',
            'font-mono text-sm text-foreground placeholder:text-muted-soft',
          )}
        />
        <InputGroupAddon
          align="block-end"
          className="cursor-default border-t border-glass-edge/60 pt-2"
        >
          <span className="flex-1" />
          {blockedReason && prompt.trim() ? (
            <span className="text-[11px] text-muted-foreground" title={blockedReason}>
              {blockedReason}
            </span>
          ) : null}
          <Button
            type="submit"
            disabled={!canSubmit}
            data-testid="composer-submit"
            title={blockedReason ?? undefined}
            className={canSubmit ? 'btn-primary-glow' : undefined}
          >
            {submitting ? 'Starting…' : 'Start task'}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
