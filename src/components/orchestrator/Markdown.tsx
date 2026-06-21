/**
 * src/components/orchestrator/Markdown.tsx
 *
 * Sanitized markdown renderer for orchestrator assistant messages (SHR-161).
 *
 * Security: react-markdown does not render raw HTML by default (no rehype-raw),
 * and we additionally run rehype-sanitize, so embedded HTML and unsafe URL
 * schemes (javascript:, data:) are stripped — no XSS from assistant output.
 * remark-gfm adds tables, strikethrough, task lists, and autolinks.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '@/lib/utils';

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        // Tailwind typography-ish defaults scoped to the chat bubble; keep links
        // visible and code blocks readable without a global prose plugin.
        'text-sm leading-relaxed [&_a]:text-[#3B82F6] [&_a]:underline',
        '[&_code]:rounded [&_code]:bg-[rgba(255,255,255,0.1)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]',
        '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[rgba(0,0,0,0.3)] [&_pre]:p-3',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_p]:my-1.5 first:[&_p]:mt-0 last:[&_p]:mb-0',
        '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold',
        '[&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-[rgba(255,255,255,0.2)] [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_table]:my-2 [&_table]:w-full [&_th]:border [&_th]:border-[rgba(255,255,255,0.12)] [&_th]:px-2 [&_th]:py-1',
        '[&_td]:border [&_td]:border-[rgba(255,255,255,0.12)] [&_td]:px-2 [&_td]:py-1',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          // Open links in a new tab with safe rel.
          a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
