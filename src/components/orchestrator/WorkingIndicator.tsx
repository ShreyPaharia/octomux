/** Animated "orchestrator is working" indicator shown while a turn is in flight. */
export function WorkingIndicator() {
  return (
    <div
      className="flex items-center gap-2 px-4 py-3"
      aria-live="polite"
      aria-label="Orchestrator is working"
    >
      <span className="flex gap-1">
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground" />
      </span>
      <span className="text-xs text-muted-foreground">orchestrator is working…</span>
    </div>
  );
}
