import { useEffect, type RefObject } from 'react';
import type { editor } from 'monaco-editor';

/**
 * Monaco diff editors inside scrollable lists often mount before their container
 * has a stable width, which leaves side-by-side panes overlapping. Relayout when
 * the host resizes or enters the viewport.
 */
export function useDiffEditorLayout(
  editor: editor.IStandaloneDiffEditor | null,
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !editor) return;

    const relayout = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width <= 0) return;
      editor.layout({ width, height: height > 0 ? height : undefined });
    };

    relayout();
    const raf = requestAnimationFrame(relayout);

    const resizeObserver = new ResizeObserver(() => relayout());
    resizeObserver.observe(el);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          requestAnimationFrame(relayout);
        }
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [editor, containerRef]);
}
