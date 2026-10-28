export function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return '방금';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}시간 전`;
  return new Date(ts).toLocaleDateString();
}

/** 이 시간 안에 에이전트가 방을 조회했으면 감시 중으로 본다 (조회 간격보다 여유 있게). */
export const AGENT_FRESH_MS = 5 * 60_000;
