import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ScrollSpyOptions {
  // IntersectionObserver root margin. Default biases the active band to the
  // top ~30% of the viewport so the file at the top of the screen is "active".
  rootMargin?: string;
  // While `now < programmaticScrollUntil.current`, observer entries are
  // ignored. Lets a click → scrollIntoView win without intermediate files
  // pinging through as the page scrolls past them.
  programmaticScrollUntil?: React.MutableRefObject<number>;
}

export interface ScrollSpy {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  observe: (el: Element, id: string) => void;
  unobserve: (el: Element) => void;
}

/**
 * Tracks the topmost element currently in the active band of the viewport.
 *
 * The active band is configured via `rootMargin` (default
 * `-20% 0px -70% 0px` — top ~30% of the viewport). When multiple observed
 * elements intersect that band, the one with the smallest `top` wins. If none
 * are in the band (e.g. one giant element fills the viewport), we fall back
 * to the largest `intersectionRatio`.
 */
export function useScrollSpy(options: ScrollSpyOptions = {}): ScrollSpy {
  const { rootMargin = '-20% 0px -70% 0px', programmaticScrollUntil } = options;

  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elToId = useRef<Map<Element, string>>(new Map());
  const idToEntry = useRef<Map<string, IntersectionObserverEntry>>(new Map());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (programmaticScrollUntil && performance.now() < programmaticScrollUntil.current) {
          // Still inside the programmatic-scroll window — keep the optimistic
          // active id the caller set.
          for (const entry of entries) {
            const id = elToId.current.get(entry.target);
            if (id) idToEntry.current.set(id, entry);
          }
          return;
        }

        for (const entry of entries) {
          const id = elToId.current.get(entry.target);
          if (id) idToEntry.current.set(id, entry);
        }

        const intersecting = Array.from(idToEntry.current.entries()).filter(
          ([, e]) => e.isIntersecting,
        );
        if (intersecting.length === 0) return;

        // Prefer entries whose bounding rect top is at or below 0 — i.e. the
        // entry that owns the top of the viewport. Pick the smallest-top among
        // those; tie-break by largest intersectionRatio.
        let best: { id: string; entry: IntersectionObserverEntry } | null = null;
        for (const [id, entry] of intersecting) {
          if (!best) {
            best = { id, entry };
            continue;
          }
          const aTop = entry.boundingClientRect.top;
          const bTop = best.entry.boundingClientRect.top;
          if (Math.abs(aTop - bTop) < 1) {
            if (entry.intersectionRatio > best.entry.intersectionRatio) best = { id, entry };
          } else if (aTop < bTop) {
            best = { id, entry };
          }
        }

        if (best) setActiveId(best.id);
      },
      { rootMargin, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    observerRef.current = observer;
    // Re-observe any elements that were registered before the observer existed.
    for (const el of elToId.current.keys()) observer.observe(el);

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [rootMargin, programmaticScrollUntil]);

  const observe = useCallback((el: Element, id: string) => {
    elToId.current.set(el, id);
    observerRef.current?.observe(el);
  }, []);

  const unobserve = useCallback((el: Element) => {
    const id = elToId.current.get(el);
    elToId.current.delete(el);
    if (id) idToEntry.current.delete(id);
    observerRef.current?.unobserve(el);
  }, []);

  return useMemo(
    () => ({ activeId, setActiveId, observe, unobserve }),
    [activeId, observe, unobserve],
  );
}
