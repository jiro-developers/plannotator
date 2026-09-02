import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RoomAck } from '../core/types';

interface AckControlProps {
  acks: RoomAck[];
  /** Current room plan version — acks below this are "확인 후 갱신됨" (stale). */
  planVersion: number;
  /** Whether the current user has confirmed the CURRENT version. */
  meConfirmed: boolean;
  onToggle: (confirmed: boolean) => void;
}

/**
 * 문서 확인 컨트롤: 헤더의 "✓ 확인 N" 칩. 클릭하면 확인자 목록 팝오버가 열리고,
 * 본인의 확인/취소 버튼이 있다. 확인 후 문서가 갱신된 사람은 "이후 갱신됨"으로 표시.
 *
 * 팝오버는 createPortal로 body 최상위에 fixed 렌더한다 — 헤더/뷰어의 sticky
 * 액션 바 등 다른 stacking context에 가리지 않도록.
 */
export function AckControl({ acks, planVersion, meConfirmed, onToggle }: AckControlProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !btnRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onScrollResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScrollResize);
    window.addEventListener('scroll', onScrollResize, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScrollResize);
      window.removeEventListener('scroll', onScrollResize, true);
    };
  }, [open]);

  // 확인은 갱신 여부와 무관하게 유효 — 전체 확인자를 센다.
  const sorted = [...acks].sort((a, b) => b.createdA - a.createdA);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
          meConfirmed
            ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
            : 'border-border/60 text-muted-foreground hover:bg-muted'
        }`}
        title="문서 확인한 사람 보기"
      >
        <span aria-hidden>✓</span>
        <span className="tabular-nums">확인 {acks.length}</span>
      </button>

      {open && pos != null &&
        createPortal(
          <div
            ref={popRef}
            style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 9999 }}
            className="w-64 overflow-hidden rounded-lg border border-border/60 bg-background text-foreground shadow-xl"
          >
            <div className="border-b border-border/50 p-2">
              <button
                type="button"
                onClick={() => {
                  onToggle(!meConfirmed);
                  if (!meConfirmed) setOpen(false);
                }}
                className={`w-full rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  meConfirmed
                    ? 'border border-border/60 text-muted-foreground hover:bg-muted'
                    : 'bg-green-600 text-white hover:bg-green-500'
                }`}
              >
                {meConfirmed ? '확인 취소' : '이 문서를 확인했어요'}
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto p-1">
              {sorted.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  아직 확인한 사람이 없어요
                </div>
              )}
              {sorted.map((ack) => {
                const stale = ack.planVersion < planVersion;
                return (
                  <div key={ack.key} className="rounded px-2 py-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-xs font-medium text-foreground">{ack.name}</span>
                      {stale && (
                        <span className="ml-auto shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                          v{ack.planVersion} · 이후 갱신됨
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {new Date(ack.createdA).toLocaleString()} 확인
                    </div>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
