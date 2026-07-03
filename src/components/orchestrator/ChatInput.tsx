import { useState, useRef, useCallback, type FormEvent, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { ORCHESTRATOR_FOCUS_RING } from './types';

export interface ChatInputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSubmit, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSubmit]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleInput = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-[rgba(255,255,255,0.08)] px-4 py-3"
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        disabled={disabled}
        placeholder="Message orchestrator (Enter to send, Shift+Enter for newline)"
        rows={1}
        aria-label="Message input"
        className={cn(
          'flex-1 resize-none overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] px-4 py-2.5 text-sm text-foreground placeholder:text-[rgba(255,255,255,0.3)] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        style={{ minHeight: 44, maxHeight: 160 }}
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        aria-label="Send message"
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#3B82F6] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40',
          ORCHESTRATOR_FOCUS_RING,
        )}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2 8h12M10 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </form>
  );
}
