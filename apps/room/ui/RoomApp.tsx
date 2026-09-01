import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { TableOfContents } from '@plannotator/ui/components/TableOfContents';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { extractFrontmatter, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { getIdentity, isCurrentUser, setCustomIdentity } from '@plannotator/ui/utils/identity';
import { getEditorMode, saveEditorMode } from '@plannotator/ui/utils/editorMode';
import type { Annotation, EditorMode } from '@plannotator/ui/types';
import type { RoomSnapshot } from '../core/types';
import {
  deleteAnnotation,
  fetchChanges,
  fetchRoom,
  patchAnnotation,
  postAnnotation,
  postReply,
  toggleVote,
  toOptimisticRoomAnnotation,
  toUiAnnotation,
  toWireInput,
} from './api';
import { RoomCardFooter } from './RoomCardFooter';
import { EmojiAutocomplete } from './EmojiAutocomplete';
import { ChangelogDiffModal } from './ChangelogDiffModal';

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
  const [editorMode, setEditorMode] = useState<EditorMode>(getEditorMode);
  const [activeTocId, setActiveTocId] = useState<string | null>(null);
  const { resolvedMode, setMode } = useTheme();

  const viewerRef = useRef<ViewerHandle>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  /** Annotation ids whose highlight is currently painted in the viewer DOM. */
  const paintedIdsRef = useRef<Set<string>>(new Set());

  const [identity, setIdentity] = useState(() => getIdentity());
  const [showChangelog, setShowChangelog] = useState(false);
  /** planVersion whose diff (vs its predecessor) is open in the modal. */
  const [diffPlanVersion, setDiffPlanVersion] = useState<number | null>(null);
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
    const next = window.prompt('닉네임 변경 (이 브라우저의 모든 방에 적용)', identity);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === identity) return;
    if (trimmed === 'agent') {
      toast.error('"agent"는 에이전트 전용 이름이에요');
      return;
    }
    setCustomIdentity(trimmed);
    setIdentity(trimmed);
    toast.success(`닉네임을 "${trimmed}"(으)로 변경했어요 — 이전 코멘트의 작성자 표시는 바뀌지 않아요`);
  }, [identity]);

  const plan = snapshot?.plan ?? '';
  const planVersion = snapshot?.planVersion ?? 0;

  const { frontmatter, content } = useMemo(() => {
    if (!plan) return { frontmatter: null, content: '' };
    const extracted = extractFrontmatter(plan);
    return { frontmatter: extracted.frontmatter, content: extracted.content };
  }, [plan]);

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

  // Poll for changes
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const current = snapshotRef.current;
      if (!current || document.hidden) return;
      try {
        const next = await fetchChanges(roomId, current.version);
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
        <header className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-border/50 px-4">
          <span className="truncate text-sm font-semibold">{snapshot.title}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {roomId}
          </span>
          <div className="relative hidden sm:block">
            <button
              type="button"
              onClick={() => setShowChangelog((v) => !v)}
              className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                showChangelog
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border/60 text-muted-foreground hover:bg-muted'
              }`}
              title="변경 이력 보기"
            >
              plan v{snapshot.planVersion} ▾
            </button>
            {showChangelog && (
              <div className="absolute left-0 top-full z-50 mt-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-border/60 bg-background p-2 shadow-lg">
                <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  변경 이력
                </div>
                {(snapshot.changelog ?? []).length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted-foreground">
                    아직 변경 이력이 없어요 — 플랜이 갱신되면 여기에 쌓입니다.
                  </div>
                )}
                {[...(snapshot.changelog ?? [])].reverse().map((entry) => (
                  <div key={entry.version} className="rounded px-2 py-1.5 text-xs hover:bg-muted/60">
                    <div className="flex items-baseline gap-2">
                      {entry.planVersion != null && (
                        <span className="font-mono text-[10px] font-semibold text-primary">
                          v{entry.planVersion}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {entry.author} · {new Date(entry.createdA).toLocaleString()}
                      </span>
                      {entry.planVersion != null && entry.planVersion >= 2 && (
                        <button
                          type="button"
                          onClick={() => {
                            setDiffPlanVersion(entry.planVersion!);
                            setShowChangelog(false);
                          }}
                          className="ml-auto rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          diff
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
                      {entry.note}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={copyRoomLink}
            className="rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            링크 복사
          </button>
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
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            <button
              type="button"
              onClick={() => setMode(resolvedMode === 'dark' ? 'light' : 'dark')}
              className="rounded border border-border/60 px-2 py-1 hover:bg-muted"
              title="라이트/다크 전환"
            >
              {resolvedMode === 'dark' ? '☀️' : '🌙'}
            </button>
            {lastSyncA && (
              <span className="hidden items-center gap-1 sm:flex">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden />
                동기화 {new Date(lastSyncA).toLocaleTimeString()}
              </span>
            )}
            <button
              type="button"
              onClick={renameIdentity}
              className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20"
              title="클릭해서 닉네임 변경"
            >
              {identity} ✎
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-border/50 px-2 py-4 lg:block">
            <TableOfContents
              blocks={blocks}
              annotations={uiAnnotations}
              activeId={activeTocId}
              onNavigate={setActiveTocId}
            />
          </aside>

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

          <AnnotationPanel
            isOpen
            blocks={blocks}
            annotations={uiAnnotations}
            selectedId={selectedAnnotationId}
            onSelect={setSelectedAnnotationId}
            onDelete={handleDeleteAnnotation}
            onEdit={handleEditAnnotation}
            sharingEnabled={false}
            width={340}
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
      {diffPlanVersion != null && (
        <ChangelogDiffModal
          roomId={roomId}
          planVersion={diffPlanVersion}
          onClose={() => setDiffPlanVersion(null)}
        />
      )}
      <EmojiAutocomplete />
      <Toaster position="bottom-right" />
    </ScrollViewportProvider>
  );
}
