/** Thin draggable divider for sidebar resizing (mouse-only; touch keeps defaults). */
export function ResizeHandle({
  onDelta,
  onEnd,
  className = '',
}: {
  /** Horizontal drag delta in px since the last event. */
  onDelta: (dx: number) => void;
  onEnd?: () => void;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={`w-1 shrink-0 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60 ${className}`}
      onMouseDown={(e) => {
        e.preventDefault();
        let lastX = e.clientX;
        const onMove = (ev: MouseEvent) => {
          onDelta(ev.clientX - lastX);
          lastX = ev.clientX;
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          onEnd?.();
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    />
  );
}
