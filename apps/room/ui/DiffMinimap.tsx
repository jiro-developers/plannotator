import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * VS Code-style overview ruler for the history diff pane: colored marks on a
 * thin strip along the scrollbar showing where added/removed/modified blocks
 * sit in the full document. Click to jump; a translucent window tracks the
 * visible viewport.
 */

interface DiffMinimapProps {
  /** The scrollable element containing the rendered diff. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Any value that changes when the rendered diff changes — triggers re-measure. */
  refreshKey: unknown;
}

interface Marker {
  /** 0..1 position of the block top within the scroll content. */
  top: number;
  /** 0..1 height of the block within the scroll content. */
  height: number;
  kind: 'added' | 'removed' | 'modified';
}

const MARKER_CLASS: Record<Marker['kind'], string> = {
  added: 'bg-green-500',
  removed: 'bg-red-500',
  modified: 'bg-amber-500',
};

const KIND_SELECTOR = '.plan-diff-added, .plan-diff-removed, .plan-diff-modified';

function kindOf(el: Element): Marker['kind'] {
  if (el.classList.contains('plan-diff-added')) return 'added';
  if (el.classList.contains('plan-diff-removed')) return 'removed';
  return 'modified';
}

export function DiffMinimap({ containerRef, refreshKey }: DiffMinimapProps) {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [viewport, setViewport] = useState<{ top: number; height: number } | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollHeight = container.scrollHeight;
    if (scrollHeight <= 0) return;
    const containerTop = container.getBoundingClientRect().top;

    const next: Marker[] = [];
    for (const el of container.querySelectorAll(KIND_SELECTOR)) {
      // A stacked-fallback modified block nests added/removed inside a
      // wrapper that itself matches nothing — but inline-modified wrappers
      // can contain nothing else, so plain iteration is enough. Skip
      // children of an already-recorded element to avoid double marks.
      if (el.parentElement?.closest(KIND_SELECTOR)) continue;
      const rect = el.getBoundingClientRect();
      const top = (rect.top - containerTop + container.scrollTop) / scrollHeight;
      const height = rect.height / scrollHeight;
      next.push({ top, height, kind: kindOf(el) });
    }
    setMarkers(next);
    setViewport({
      top: container.scrollTop / scrollHeight,
      height: container.clientHeight / scrollHeight,
    });
  }, [containerRef]);

  // Re-measure when the diff re-renders (async markdown/highlight work
  // settles quickly; a ResizeObserver on the content catches the rest).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const timer = window.setTimeout(measure, 120);
    const observer = new ResizeObserver(measure);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    observer.observe(container);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [refreshKey, measure, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const scrollHeight = container.scrollHeight;
      if (scrollHeight <= 0) return;
      setViewport({
        top: container.scrollTop / scrollHeight,
        height: container.clientHeight / scrollHeight,
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [containerRef, refreshKey]);

  const jumpTo = useCallback(
    (ratio: number) => {
      const container = containerRef.current;
      if (!container) return;
      container.scrollTo({
        top: ratio * container.scrollHeight - container.clientHeight / 2,
        behavior: 'smooth',
      });
    },
    [containerRef]
  );

  if (markers.length === 0) return null;

  return (
    <div
      className="absolute bottom-0 right-0 top-0 z-10 w-3 cursor-pointer bg-muted/30"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        jumpTo((e.clientY - rect.top) / rect.height);
      }}
      title="변경 위치 — 클릭해서 이동"
    >
      {markers.map((marker, i) => (
        <div
          key={i}
          className={`absolute left-[3px] w-1.5 rounded-sm ${MARKER_CLASS[marker.kind]}`}
          style={{
            top: `${marker.top * 100}%`,
            height: `max(${marker.height * 100}%, 3px)`,
          }}
        />
      ))}
      {viewport && viewport.height < 0.999 && (
        <div
          className="absolute left-0 right-0 rounded-sm border border-foreground/25 bg-foreground/10"
          style={{ top: `${viewport.top * 100}%`, height: `${viewport.height * 100}%` }}
        />
      )}
    </div>
  );
}
