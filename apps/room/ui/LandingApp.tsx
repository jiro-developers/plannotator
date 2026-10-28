import { useEffect, useMemo, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { getIdentity } from '@plannotator/ui/utils/identity';
import type { RoomSummary } from '../core/types';
import { createRoom, fetchRoomList } from './api';
import { AGENT_FRESH_MS, formatAgo } from './time';

type ListTab = 'mine' | 'all';

const TAB_LABEL: Record<ListTab, string> = { mine: '내가 참여한 방', all: '전체' };
const TAB_LIST: ListTab[] = ['mine', 'all'];

function loadTab(): ListTab {
  return localStorage.getItem('room.listTab') === 'all' ? 'all' : 'mine';
}

/**
 * 방 목록 + 새 방 만들기. 에이전트는 보통 POST /api/rooms로 방을 만들고,
 * 사람은 여기서 참여한 방을 다시 찾아 들어간다.
 */
export function LandingApp() {
  const identity = useMemo(() => getIdentity(), []);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<ListTab>(loadTab);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [plan, setPlan] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchRoomList(identity)
      .then(({ rooms: list }) => setRooms(list))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [identity]);

  const mineCount = rooms?.filter((room) => room.participated).length ?? 0;
  const visibleRooms = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (rooms ?? []).filter(
      (room) =>
        (tab === 'all' || room.participated) &&
        (!keyword || room.title.toLowerCase().includes(keyword) || room.id.toLowerCase().includes(keyword))
    );
  }, [rooms, tab, query]);

  const handleCreate = async () => {
    if (!plan.trim() || creating) return;
    setCreating(true);
    try {
      const { id } = await createRoom(plan, title.trim() || undefined, identity);
      window.location.href = `/r/${id}`;
    } catch (e: unknown) {
      toast.error(`방 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-5 px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Plannotator Room</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            팀원들과 플랜에 인라인 코멘트를 남기는 방이에요. 에이전트는 REST API(
            <code className="font-mono text-xs">/api/rooms</code>)로 방을 만들고 코멘트를 반영해요.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {identity}
          </span>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
          >
            {showCreate ? '닫기' : '새 방 만들기'}
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card p-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목 (비우면 첫 heading 사용)"
            className="rounded border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
          <textarea
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            placeholder="# 플랜 마크다운을 붙여넣으세요"
            rows={14}
            className="resize-y rounded border border-border/60 bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
          />
          <div>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating || !plan.trim()}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {creating ? '생성 중…' : '방 만들기'}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center rounded-lg border border-border/60 p-0.5">
          {TAB_LIST.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setTab(id);
                localStorage.setItem('room.listTab', id);
              }}
              className={`rounded-md px-3 py-1 text-xs transition-colors ${
                tab === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {TAB_LABEL[id]}
              {rooms && <span className="ml-1 tabular-nums opacity-70">{id === 'mine' ? mineCount : rooms.length}</span>}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="제목·방 코드 검색"
          className="w-64 rounded-md border border-border/60 bg-background px-3 py-1.5 text-xs outline-none focus:border-primary/50"
        />
      </div>

      {loadError ? (
        <div className="py-16 text-center text-sm text-muted-foreground">방 목록을 불러오지 못했어요: {loadError}</div>
      ) : rooms === null ? (
        <div className="py-16 text-center text-sm text-muted-foreground">불러오는 중…</div>
      ) : visibleRooms.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          {query.trim()
            ? '검색 결과가 없어요'
            : tab === 'mine'
              ? '아직 참여한 방이 없어요. 코멘트·답글·투표·문서 확인을 남긴 방이 여기에 모여요.'
              : '방이 없어요'}
        </div>
      ) : (
        <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
          {visibleRooms.map((room) => {
            const agentFresh = room.agentLastSeenA != null && Date.now() - room.agentLastSeenA < AGENT_FRESH_MS;
            return (
              <li key={room.id}>
                <a
                  href={`/r/${room.id}`}
                  className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{room.title}</span>
                      {room.renderAs === 'html' && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">HTML</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono">{room.id}</span>
                      <span>·</span>
                      <span>plan v{room.planVersion}</span>
                      <span>·</span>
                      <span>{formatAgo(room.updatedA)} 수정</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
                    {room.openCount > 0 && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                        미처리 {room.openCount}
                      </span>
                    )}
                    <span className="tabular-nums">코멘트 {room.annotationCount}</span>
                    <span className="tabular-nums">확인 {room.ackCount}명</span>
                    <span className="flex w-28 items-center gap-1">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          agentFresh ? 'bg-green-500' : 'bg-muted-foreground/40'
                        }`}
                        aria-hidden
                      />
                      {room.agentLastSeenA != null ? `Agent ${formatAgo(room.agentLastSeenA)}` : 'Agent 미확인'}
                    </span>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <Toaster position="bottom-right" />
    </div>
  );
}
