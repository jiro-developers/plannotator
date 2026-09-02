import type { AckSummary } from './api';
import { Tooltip } from './Tooltip';

/**
 * 인덱스 문서의 하위 방 링크 옆에 붙는 "✓ N" 확인 배지.
 * 호버하면 확인자 이름 목록(옛 버전 확인자는 vN 병기)이 뜬다.
 */
export function AckLinkBadge({ summary }: { summary: AckSummary }) {
  const count = summary.acks.length;
  return (
    <Tooltip
      className="inline-block align-baseline"
      content={
        count === 0 ? (
          '아직 확인한 사람이 없어요'
        ) : (
          <>
            {summary.acks.map((ack) => (
              <div key={ack.key}>
                {ack.name}
                {ack.planVersion < summary.planVersion && (
                  <span className="text-amber-600 dark:text-amber-400"> · v{ack.planVersion} 확인</span>
                )}
              </div>
            ))}
          </>
        )
      }
    >
      <span
        className={`ml-1 inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px align-middle text-[10px] font-medium leading-4 ${
          count > 0
            ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
            : 'border-border/60 bg-muted/40 text-muted-foreground'
        }`}
      >
        ✓ {count}
      </span>
    </Tooltip>
  );
}
