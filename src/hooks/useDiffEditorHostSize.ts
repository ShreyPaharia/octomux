import { useEffect, useState, type RefObject } from 'react';

export interface DiffEditorHostSize {
  width: number;
  height: number;
}

function readHostSize(el: HTMLElement): DiffEditorHostSize {
  let width = el.clientWidth;
  let height = el.clientHeight;
  // jsdom reports 0×0; tests still need Monaco to mount.
  if (width === 0 && import.meta.env.MODE === 'test') {
    width = 1024;
    height = height || 400;
  }
  return { width, height };
}

/** Track the diff editor host's pixel size. Monaco must not mount until width > 0. */
export function useDiffEditorHostSize(
  hostRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): DiffEditorHostSize {
  const [size, setSize] = useState<DiffEditorHostSize>({ width: 0, height: 0 });

  useEffect(() => {
    if (!enabled) {
      setSize({ width: 0, height: 0 });
      return;
    }
    const el = hostRef.current;
    if (!el) return;

    const update = () => setSize(readHostSize(el));
    update();

    const resizeObserver = new ResizeObserver(() => update());
    resizeObserver.observe(el);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) update();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [enabled, hostRef]);

  return size;
}
