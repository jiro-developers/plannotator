import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { TableOfContents } from '@plannotator/ui/components/TableOfContents';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { extractFrontmatter, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { getIdentity, isCurrentUser, isIdentityEditable, setCustomIdentity } from '@plannotator/ui/utils/identity';
import { getEditorMode, saveEditorMode } from '@plannotator/ui/utils/editorMode';
import { AnnotationType, type Annotation, type EditorMode } from '@plannotator/ui/types';
import type { RoomSnapshot } from '../core/types';
import {
  deleteAnnotation,
  fetchAckSummaries,
  fetchChanges,
  fetchRoom,
  type AckSummary,
  patchAnnotation,
  postAnnotation,
  postReply,
  setAck,
  toggleVote,
  toOptimisticRoomAnnotation,
  toUiAnnotation,
  toWireInput,
} from './api';
import { RoomCardFooter } from './RoomCardFooter';
import { EmojiAutocomplete } from './EmojiAutocomplete';
import { HistoryModal } from './HistoryModal';
import { ResizeHandle } from './ResizeHandle';
import { getAuthedRename } from './AuthGate';
import { AckControl } from './AckControl';
import { AckLinkBadge } from './AckLinkBadge';
import { Tooltip } from './Tooltip';
import { createPortal } from 'react-dom';

const clampWidth = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function loadWidth(key: string, fallback: number, min: number, max: number): number {
  const saved = Number(localStorage.getItem(key));
  return Number.isFinite(saved) && saved > 0 ? clampWidth(saved, min, max) : fallback;
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return '방금';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}시간 전`;
  return new Date(ts).toLocaleDateString();
}

/** 에이전트 폴링 주기(3분)보다 조금 여유 있게 — 이 안이면 "폴링 중"으로 본다. */
const AGENT_FRESH_MS = 5 * 60_000;

const POLL_INTERVAL_MS = 10_000;
/** Delay before re-anchoring highlights so the viewer DOM is fully rendered. */
const REPAINT_DELAY_MS = 150;

const MODE_OPTION_LIST: Array<{ id: EditorMode; label: string }> = [
  { id: 'selection', label: 'Select' },
  { id: 'comment', label: 'Comment' },
  { id: 'redline', label: 'Redline' },
];


export function RoomApp({ roomId }: { roomId: string }) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [lastSyncA, setLastSyncA] = useState<number | null>(null);
  /** 에이전트가 마지막으로 이 방을 폴링한 시각 (서버 하트비트). */
  const [agentSeenA, setAgentSeenA] = useState<number | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>(getEditorMode);
  const [activeTocId, setActiveTocId] = useState<string | null>(null);
  const { resolvedMode, setMode } = useTheme();

  const viewerRef = useRef<ViewerHandle>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  /** Annotation ids whose highlight is currently painted in the viewer DOM. */
  const paintedIdsRef = useRef<Set<string>>(new Set());

  const [identity, setIdentity] = useState(() => getIdentity());
  const [showHistory, setShowHistory] = useState(false);
  /** html 모드의 global comment 입력 패널. */
  const [showGlobalInput, setShowGlobalInput] = useState(false);
  const [globalInputText, setGlobalInputText] = useState('');
  /** 문서에 링크된 하위 방들의 확인 현황 (인덱스 문서용). */
  const [ackSummaries, setAckSummaries] = useState<ReadonlyMap<string, AckSummary>>(new Map());
  /** 렌더된 하위 방 링크 옆에 만든 배지 마운트 지점들. */
  const [ackBadgeTargets, setAckBadgeTargets] = useState<Array<{ code: string; el: HTMLElement }>>([]);
  // 양쪽 사이드바 폭 — 드래그로 조절, 브라우저별로 기억
  const [tocWidth, setTocWidth] = useState(() => loadWidth('room.tocWidth', 240, 160, 480));
  const [panelWidth, setPanelWidth] = useState(() => loadWidth('room.panelWidth', 340, 260, 640));
  const tocWidthRef = useRef(tocWidth);
  tocWidthRef.current = tocWidth;
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  /** Annotations that no longer anchor to the current plan text (document drift). */
  const [lostAnchorIds, setLostAnchorIds] = useState<ReadonlySet<string>>(new Set());

  const handleRestoreMismatch = useCallback((annotation: Annotation) => {
    setLostAnchorIds((prev) => {
      if (prev.has(annotation.id)) return prev;
      const next = new Set(prev);
      next.add(annotation.id);
      return next;
    });
  }, []);

  const renameIdentity = useCallback(() => {
    const next = window.prompt('닉네임 변경 (이후 작성하는 코멘트부터 적용)', identity);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === identity) return;
    if (trimmed.toLowerCase() === 'agent') {
      toast.error('"agent"는 에이전트 전용 이름이에요');
      return;
    }
    const authRename = getAuthedRename();
    const apply = authRename
      ? authRename(trimmed)
      : Promise.resolve().then(() => {
          setCustomIdentity(trimmed);
        });
    apply
      .then(() => {
        setIdentity(trimmed);
        toast.success(`닉네임을 "${trimmed}"(으)로 변경했어요 — 이전 코멘트의 작성자 표시는 바뀌지 않아요`);
      })
      .catch((e: unknown) => {
        toast.error(`변경 실패: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [identity]);

  const plan = snapshot?.plan ?? '';
  const planVersion = snapshot?.planVersion ?? 0;
  /** 'html'이면 본문을 sandbox iframe으로 렌더하고 global comment만 지원한다. */
  const isHtml = snapshot?.renderAs === 'html';

  const { frontmatter, content } = useMemo(() => {
    if (!plan || isHtml) return { frontmatter: null, content: '' };
    const extracted = extractFrontmatter(plan);
    return { frontmatter: extracted.frontmatter, content: extracted.content };
  }, [plan, isHtml]);

  const blocks = useMemo(() => parseMarkdownToBlocks(content), [content]);

  const uiAnnotations = useMemo(
    () => (snapshot?.annotations ?? []).map(toUiAnnotation),
    [snapshot?.annotations]
  );

  const roomAnnotationById = useMemo(
    () => new Map((snapshot?.annotations ?? []).map((a) => [a.id, a])),
    [snapshot?.annotations]
  );

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // 브라우저 탭에 방 제목 표시
  useEffect(() => {
    if (snapshot?.title) document.title = `${snapshot.title} · Plannotator Room`;
  }, [snapshot?.title]);

  /** Merge a fresh server snapshot: clear highlights of removed annotations. */
  const applySnapshot = useCallback((next: RoomSnapshot) => {
    const nextIds = new Set(next.annotations.map((a) => a.id));
    for (const id of paintedIdsRef.current) {
      if (!nextIds.has(id)) {
        viewerRef.current?.removeHighlight(id);
        paintedIdsRef.current.delete(id);
      }
    }
    setSnapshot(next);
    setLastSyncA(Date.now());
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySnapshot(await fetchRoom(roomId));
    } catch {
      // next poll retries
    }
  }, [roomId, applySnapshot]);

  // Initial load
  useEffect(() => {
    fetchRoom(roomId)
      .then((doc) => {
        setSnapshot(doc);
        setLastSyncA(Date.now());
        if (doc.agentLastSeenA) setAgentSeenA(doc.agentLastSeenA);
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : 'Failed to load room');
      });
  }, [roomId]);

  /** Paint highlights for anchored annotations not yet in the viewer DOM. */
  const paintPending = useCallback(() => {
    const current = snapshotRef.current;
    if (!current) return;
    const pending = current.annotations.filter(
      (a) => a.type !== 'GLOBAL_COMMENT' && !paintedIdsRef.current.has(a.id)
    );
    if (pending.length === 0) return;
    window.setTimeout(() => {
      viewerRef.current?.applySharedAnnotations(pending.map(toUiAnnotation));
      for (const a of pending) paintedIdsRef.current.add(a.id);
    }, REPAINT_DELAY_MS);
  }, []);

  // The viewer remounts when the plan changes (key={planVersion}) — all
  // highlight DOM is lost, so repaint everything from scratch.
  useEffect(() => {
    if (planVersion === 0) return;
    paintedIdsRef.current = new Set();
    // A new plan version may re-anchor previously lost annotations — retry all.
    setLostAnchorIds(new Set());
    paintPending();
  }, [planVersion, paintPending]);

  // New remote annotations arriving via polling get anchored here.
  useEffect(() => {
    paintPending();
  }, [uiAnnotations, paintPending]);

  // 문서에 링크된 하위 방 코드 추출 (인덱스 문서 지원)
  const linkedRoomIds = useMemo(() => {
    const ids = new Set<string>();
    for (const match of plan.matchAll(/\/r\/([A-Za-z0-9]{6,16})/g)) {
      if (match[1] !== roomId) ids.add(match[1]);
    }
    return [...ids];
  }, [plan, roomId]);
  const linkedRoomKey = linkedRoomIds.join(',');

  // 하위 방 확인 현황 조회 — 초기 + 30초 주기 갱신
  useEffect(() => {
    if (linkedRoomIds.length === 0) {
      setAckSummaries(new Map());
      return;
    }
    let cancelled = false;
    const load = () => {
      fetchAckSummaries(linkedRoomIds)
        .then(({ summaries }) => {
          if (!cancelled) setAckSummaries(new Map(summaries.map((s) => [s.id, s])));
        })
        .catch(() => {
          // 다음 주기에 재시도
        });
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRoomKey]);

  // 렌더된 링크 옆에 배지 마운트 지점 삽입 (뷰어 리마운트마다 재스캔)
  useEffect(() => {
    if (!viewport || linkedRoomIds.length === 0) {
      setAckBadgeTargets([]);
      return;
    }
    const timer = window.setTimeout(() => {
      viewport.querySelectorAll('[data-ack-badge]').forEach((el) => el.remove());
      const targets: Array<{ code: string; el: HTMLElement }> = [];
      viewport.querySelectorAll<HTMLAnchorElement>('a[href*="/r/"]').forEach((anchor) => {
        const match = anchor.getAttribute('href')?.match(/\/r\/([A-Za-z0-9]{6,16})/);
        if (!match || match[1] === roomId) return;
        const mount = document.createElement('span');
        mount.setAttribute('data-ack-badge', match[1]);
        anchor.insertAdjacentElement('afterend', mount);
        targets.push({ code: match[1], el: mount });
      });
      setAckBadgeTargets(targets);
    }, REPAINT_DELAY_MS + 100);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, planVersion, linkedRoomKey]);

  // Poll for changes
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const current = snapshotRef.current;
      if (!current || document.hidden) return;
      try {
        const { snapshot: next, agentLastSeenA } = await fetchChanges(roomId, current.version);
        if (agentLastSeenA) setAgentSeenA(agentLastSeenA);
        if (next) {
          applySnapshot(next);
        } else {
          setLastSyncA(Date.now());
        }
      } catch {
        // transient network error — next tick retries
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [roomId, applySnapshot]);

  const handleAddAnnotation = useCallback(
    (annotation: Annotation) => {
      // The viewer already painted the local highlight.
      paintedIdsRef.current.add(annotation.id);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              annotations: [
                ...current.annotations,
                toOptimisticRoomAnnotation(annotation, identity, current.annotations.length + 1),
              ],
            }
          : current
      );
      postAnnotation(roomId, toWireInput(annotation, identity))
        .then(() => refresh())
        .catch((e: unknown) => {
          toast.error(`코멘트 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
          paintedIdsRef.current.delete(annotation.id);
          viewerRef.current?.removeHighlight(annotation.id);
          setSnapshot((current) =>
            current
              ? { ...current, annotations: current.annotations.filter((a) => a.id !== annotation.id) }
              : current
          );
        });
    },
    [roomId, identity, refresh]
  );

  const handleDeleteAnnotation = useCallback(
    (id: string) => {
      const target = roomAnnotationById.get(id);
      if (!target) return;
      if (!isCurrentUser(target.author)) {
        toast.error('본인이 작성한 코멘트만 삭제할 수 있어요');
        return;
      }
      deleteAnnotation(roomId, id, identity)
        .then(() => {
          viewerRef.current?.removeHighlight(id);
          paintedIdsRef.current.delete(id);
          if (selectedAnnotationId === id) setSelectedAnnotationId(null);
          return refresh();
        })
        .catch((e: unknown) => {
          toast.error(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [roomId, identity, roomAnnotationById, selectedAnnotationId, refresh]
  );

  const handleEditAnnotation = useCallback(
    (id: string, updates: Partial<Annotation>) => {
      const target = roomAnnotationById.get(id);
      if (!target || typeof updates.text !== 'string') return;
      if (!isCurrentUser(target.author)) {
        toast.error('본인이 작성한 코멘트만 수정할 수 있어요');
        return;
      }
      patchAnnotation(roomId, id, { author: identity, text: updates.text })
        .then(() => refresh())
        .catch((e: unknown) => {
          toast.error(`수정 실패: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [roomId, identity, roomAnnotationById, refresh]
  );

  const handleVote = useCallback(
    (annotationId: string) => {
      toggleVote(roomId, annotationId, identity)
        .then(() => refresh())
        .catch((e: unknown) => {
          toast.error(`투표 실패: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [roomId, identity, refresh]
  );

  const handleReply = useCallback(
    async (annotationId: string, text: string) => {
      try {
        await postReply(roomId, annotationId, identity, text);
        await refresh();
      } catch (e: unknown) {
        toast.error(`답글 실패: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
    [roomId, identity, refresh]
  );

  const requestCommit = useCallback(() => {
    fetch(`/api/rooms/${roomId}/signals/commit`, { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        toast.success('커밋을 요청했어요 — 에이전트가 다음 확인 때(최대 3분) 누적 변경을 커밋·푸시합니다');
        await refresh();
      })
      .catch((e: unknown) => {
        toast.error(`커밋 요청 실패: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [roomId, refresh]);

  const submitGlobalComment = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      handleAddAnnotation({
        id: crypto.randomUUID(),
        blockId: '',
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.GLOBAL_COMMENT,
        text: trimmed,
        originalText: '',
        createdA: Date.now(),
        author: identity,
      });
    },
    [identity, handleAddAnnotation]
  );

  const toggleAck = useCallback(
    (confirmed: boolean) => {
      setAck(roomId, confirmed, identity)
        .then(() => refresh())
        .then(() => toast.success(confirmed ? '문서를 확인했어요' : '확인을 취소했어요'))
        .catch((e: unknown) => {
          toast.error(`문서 확인 실패: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [roomId, identity, refresh]
  );

  const copyRoomLink = useCallback(() => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      toast.success('방 링크를 복사했어요');
    });
  }, []);

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 text-center">
        <div className="text-lg font-semibold text-foreground">방을 열 수 없습니다</div>
        <div className="text-sm text-muted-foreground">{loadError}</div>
        <a href="/" className="mt-2 text-sm text-primary underline">
          새 방 만들기
        </a>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        불러오는 중…
      </div>
    );
  }

  return (
    <ScrollViewportProvider viewport={viewport}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="relative z-40 flex h-12 flex-shrink-0 items-center gap-3 border-b border-border/50 bg-background px-4">
          <span className="truncate text-sm font-semibold">{snapshot.title}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {roomId}
          </span>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="hidden rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted sm:block"
          >
            plan v{snapshot.planVersion} · 이력
          </button>
          <button
            type="button"
            onClick={copyRoomLink}
            className="rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            링크 복사
          </button>
          {isHtml ? (
            <button
              type="button"
              onClick={() => setShowGlobalInput(true)}
              className="ml-2 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              💬 Global comment
            </button>
          ) : (
            <div className="ml-2 hidden items-center rounded-lg border border-border/60 p-0.5 md:flex">
              {MODE_OPTION_LIST.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setEditorMode(option.id);
                    saveEditorMode(option.id);
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    editorMode === option.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            <AckControl
              acks={snapshot.acks ?? []}
              planVersion={snapshot.planVersion}
              meConfirmed={(snapshot.acks ?? []).some((a) => a.name === identity)}
              onToggle={toggleAck}
            />
            {snapshot.signals?.commitRequestedA != null ? (
              <Tooltip
                content={`${snapshot.signals.commitRequestedBy ?? '누군가'}님이 요청 — 에이전트가 다음 사이클에 커밋합니다`}
              >
                <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                  커밋 대기 중
                </span>
              </Tooltip>
            ) : (
              snapshot.planVersion > (snapshot.signals?.lastCommittedPlanVersion ?? 1) && (
                <Tooltip content="에이전트에게 누적된 반영분을 git 커밋·푸시하도록 요청">
                  <button
                    type="button"
                    onClick={requestCommit}
                    className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition-colors hover:bg-green-500"
                  >
                    커밋 요청
                  </button>
                </Tooltip>
              )
            )}
            <Tooltip content="라이트/다크 전환">
              <button
                type="button"
                onClick={() => setMode(resolvedMode === 'dark' ? 'light' : 'dark')}
                className="rounded border border-border/60 px-2 py-1 hover:bg-muted"
              >
                {resolvedMode === 'dark' ? '☀️' : '🌙'}
              </button>
            </Tooltip>
            <Tooltip
              className="hidden sm:block"
              content={
                <>
                  에이전트가 마지막으로 이 방을 확인한 시각 기준
                  {agentSeenA != null && (
                    <>
                      <br />
                      {new Date(agentSeenA).toLocaleString()} 확인
                    </>
                  )}
                  {lastSyncA && (
                    <>
                      <br />
                      브라우저 동기화 {new Date(lastSyncA).toLocaleTimeString()}
                    </>
                  )}
                </>
              }
            >
              <span className="flex items-center gap-1">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    agentSeenA != null && Date.now() - agentSeenA < AGENT_FRESH_MS
                      ? 'bg-green-500'
                      : 'bg-muted-foreground/40'
                  }`}
                  aria-hidden
                />
                {agentSeenA != null ? `Agent 확인 ${formatAgo(agentSeenA)}` : 'Agent 미확인'}
              </span>
            </Tooltip>
            {isIdentityEditable() ? (
              <Tooltip content="클릭해서 닉네임 변경">
                <button
                  type="button"
                  onClick={renameIdentity}
                  className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20"
                >
                  {identity} ✎
                </button>
              </Tooltip>
            ) : (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                {identity}
              </span>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {!isHtml && (
            <>
              <aside
                style={{ width: tocWidth }}
                className="hidden shrink-0 overflow-y-auto border-r border-border/50 px-2 py-4 lg:block"
              >
                <TableOfContents
                  blocks={blocks}
                  annotations={uiAnnotations}
                  activeId={activeTocId}
                  onNavigate={setActiveTocId}
                />
              </aside>
              <ResizeHandle
                className="hidden lg:block"
                onDelta={(dx) => setTocWidth((w) => clampWidth(w + dx, 160, 480))}
                onEnd={() => localStorage.setItem('room.tocWidth', String(tocWidthRef.current))}
              />
            </>
          )}

          {isHtml ? (
            <div className="min-w-0 flex-1">
              <iframe
                key={planVersion}
                title={snapshot.title}
                srcDoc={plan}
                sandbox="allow-scripts allow-popups"
                className="h-full w-full border-0"
                style={{ background: '#fff', colorScheme: 'light' }}
              />
            </div>
          ) : (
            <OverlayScrollArea
              element="main"
              className="bg-grid min-w-0 flex-1"
              onViewportReady={setViewport}
            >
              <div className="mx-auto max-w-4xl px-6 py-8">
                <Viewer
                  key={planVersion}
                  ref={viewerRef}
                  blocks={blocks}
                  markdown={content}
                  frontmatter={frontmatter}
                  annotations={uiAnnotations}
                  onAddAnnotation={handleAddAnnotation}
                  onSelectAnnotation={setSelectedAnnotationId}
                  selectedAnnotationId={selectedAnnotationId}
                  mode={editorMode}
                  verifyRestoredContent
                  onRestoreMismatch={handleRestoreMismatch}
                  taterMode={false}
                  stickyActions
                  gridEnabled
                  allowImages={false}
                  disableCodePathValidation
                />
              </div>
            </OverlayScrollArea>
          )}

          <ResizeHandle
            onDelta={(dx) => setPanelWidth((w) => clampWidth(w - dx, 260, 640))}
            onEnd={() => localStorage.setItem('room.panelWidth', String(panelWidthRef.current))}
          />
          <AnnotationPanel
            isOpen
            blocks={blocks}
            annotations={uiAnnotations}
            selectedId={selectedAnnotationId}
            onSelect={setSelectedAnnotationId}
            onDelete={handleDeleteAnnotation}
            onEdit={handleEditAnnotation}
            sharingEnabled={false}
            width={panelWidth}
            renderCardFooter={(annotation) => {
              const roomAnnotation = roomAnnotationById.get(annotation.id);
              if (!roomAnnotation) return null;
              return (
                <RoomCardFooter
                  annotation={roomAnnotation}
                  identity={identity}
                  anchorLost={lostAnchorIds.has(roomAnnotation.id)}
                  onVote={handleVote}
                  onReply={handleReply}
                />
              );
            }}
          />
        </div>
      </div>
      {showHistory && (
        <HistoryModal
          roomId={roomId}
          changelog={snapshot.changelog ?? []}
          renderAs={snapshot.renderAs}
          onClose={() => setShowHistory(false)}
        />
      )}
      {ackBadgeTargets.map(({ code, el }, index) => {
        const summary = ackSummaries.get(code);
        if (!summary) return null;
        return createPortal(<AckLinkBadge summary={summary} />, el, `ack-badge-${index}-${code}`);
      })}
      {showGlobalInput && (
        <div
          className="fixed inset-0 z-[9000] flex items-start justify-center bg-black/40 pt-24"
          onClick={() => setShowGlobalInput(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-border/60 bg-background p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold">Global comment</div>
            <textarea
              autoFocus
              value={globalInputText}
              onChange={(e) => setGlobalInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitGlobalComment(globalInputText);
                  setGlobalInputText('');
                  setShowGlobalInput(false);
                }
                if (e.key === 'Escape') setShowGlobalInput(false);
              }}
              rows={4}
              placeholder="문서 전체에 대한 코멘트… (⌘+Enter 전송)"
              className="w-full resize-none rounded-md border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowGlobalInput(false)}
                className="rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                취소
              </button>
              <button
                type="button"
                disabled={!globalInputText.trim()}
                onClick={() => {
                  submitGlobalComment(globalInputText);
                  setGlobalInputText('');
                  setShowGlobalInput(false);
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                코멘트 남기기
              </button>
            </div>
          </div>
        </div>
      )}
      <EmojiAutocomplete />
      <Toaster position="bottom-right" />
    </ScrollViewportProvider>
  );
}
