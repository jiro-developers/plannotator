import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: ReactNode;
  /** 트리거 기준 표시 방향. 기본 bottom. */
  side?: 'top' | 'bottom';
  /** 표시 지연(ms). native title(~1초)보다 훨씬 짧게. */
  delayMs?: number;
  /** 트리거 래퍼(span)에 줄 클래스 — 블록 레이아웃이 필요하면 "block" 등. */
  className?: string;
  children: ReactNode;
}

/**
 * 공용 커스텀 툴팁. native title의 느린 표시를 대체한다.
 * Portal + fixed 렌더라 어떤 stacking context에도 가리지 않는다.
 */
export function Tooltip({ content, side = 'bottom', delayMs = 150, className, children }: TooltipProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const show = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const half = 150; // max-w의 절반 근사 — 화면 밖으로 나가지 않게 클램프
      setPos({
        top: side === 'bottom' ? rect.bottom + 6 : rect.top - 6,
        left: Math.min(Math.max(rect.left + rect.width / 2, half), window.innerWidth - half),
      });
    }, delayMs);
  };
  const hide = () => {
    window.clearTimeout(timerRef.current);
    setPos(null);
  };

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return (
    <span
      ref={triggerRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className={className}
    >
      {children}
      {pos != null &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              zIndex: 10000,
              transform: side === 'bottom' ? 'translateX(-50%)' : 'translate(-50%, -100%)',
            }}
            className="pointer-events-none max-w-72 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground shadow-lg"
          >
            {content}
          </div>,
          document.body
        )}
    </span>
  );
}
