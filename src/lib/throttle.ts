/**
 * Leading-edge throttle with trailing flush: the first call runs immediately,
 * calls during the cooldown collapse into one trailing run. Used to stop
 * `/ws/events` bursts (agents broadcast per tool call) from turning into
 * REST refetch storms over slow links, without delaying isolated events.
 */
export interface Throttled {
  (): void;
  cancel(): void;
}

export function throttle(fn: () => void, ms: number): Throttled {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const run = () => {
    fn();
    timer = setTimeout(() => {
      timer = null;
      if (pending) {
        pending = false;
        run();
      }
    }, ms);
  };

  const throttled = () => {
    if (timer === null) run();
    else pending = true;
  };
  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = false;
  };
  return throttled;
}
