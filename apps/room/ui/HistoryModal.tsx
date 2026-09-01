import { useEffect, useMemo, useState } from 'react';
import { computePlanDiff, type PlanDiffBlock, type PlanDiffStats } from '@plannotator/ui/utils/planDiffEngine';
import { PlanCleanDiffView } from '@plannotator/ui/components/plan-diff/PlanCleanDiffView';
import type { RoomChangelogEntry } from '../core/types';
import { fetchPlanVersion } from './api';

interface HistoryModalProps {
  roomId: string;
  changelog: RoomChangelogEntry[];
  onClose: () => void;
}

interface VersionRow {
  planVersion: number;
  note: string;
  author: string;
  createdA: number;
}

type DiffState =
  | { phase: 'loading' }
  | { phase: 'first-version' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; blocks: PlanDiffBlock[]; stats: PlanDiffStats };

/**
 * Full-screen history browser: version list on the left, the selected
 * version's diff (vs its predecessor) on the right.
 */
export function HistoryModal({ roomId, changelog, onClose }: HistoryModalProps) {
  // One row per planVersion (a version's note is its changelog entry), newest first.
  const versions = useMemo<VersionRow[]>(() => {
    const byVersion = new Map<number, VersionRow>();
    for (const entry of changelog) {
      if (entry.planVersion == null) continue;
      byVersion.set(entry.planVersion, {
        planVersion: entry.planVersion,
        note: entry.note,
        author: entry.author,
        createdA: entry.createdA,
      });
    }
    return [...byVersion.values()].sort((a, b) => b.planVersion - a.planVersion);
  }, [changelog]);

  const [selected, setSelected] = useState<number | null>(versions[0]?.planVersion ?? null);
  const [state, setState] = useState<DiffState>({ phase: 'loading' });

  useEffect(() => {
    if (selected == null) return;
    if (selected <= 1) {
      setState({ phase: 'first-version' });
      return;
    }
    let cancelled = false;
    setState({ phase: 'loading' });
    Promise.all([fetchPlanVersion(roomId, selected - 1), fetchPlanVersion(roomId, selected)])
      .then(([prev, next]) => {
        if (cancelled) return;
        const { blocks, stats } = computePlanDiff(prev.plan, next.plan);
        setState({ phase: 'ready', blocks, stats });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message =
          e instanceof Error && e.message === 'Version not found'
            ? '이 버전의 원문이 저장되어 있지 않아 비교할 수 없어요. (버전 본문 보존 기능이 추가되기 전의 변경입니다 — 이후 변경부터는 diff가 제공돼요)'
            : e instanceof Error
              ? e.message
              : '버전을 불러오지 못했어요';
        setState({ phase: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, selected]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const selectedRow = versions.find((v) => v.planVersion === selected) ?? null;

  return (
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="플랜 변경 이력"
    >
      <div
        className="flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
          <span className="text-sm font-semibold">변경 이력</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {versions.length}개 버전
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            닫기 (Esc)
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 좌측: 버전 목록 */}
          <div className="w-64 flex-shrink-0 overflow-y-auto border-r border-border/50 p-2">
            {versions.length === 0 && (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                아직 변경 이력이 없어요 — 플랜이 갱신되면 여기에 쌓입니다.
              </div>
            )}
            {versions.map((row) => (
              <button
                key={row.planVersion}
                type="button"
                onClick={() => setSelected(row.planVersion)}
                className={`mb-1 block w-full rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                  row.planVersion === selected
                    ? 'bg-primary/10 ring-1 ring-primary/40'
                    : 'hover:bg-muted/60'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] font-bold text-primary">
                    v{row.planVersion}
                  </span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {row.author} · {new Date(row.createdA).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 break-words text-muted-foreground">
                  {row.note}
                </div>
              </button>
            ))}
          </div>

          {/* 우측: 선택 버전 diff */}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {selectedRow && (
              <div className="border-b border-border/40 px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold">
                    {selectedRow.planVersion <= 1
                      ? `v${selectedRow.planVersion} (최초 게시)`
                      : `v${selectedRow.planVersion - 1} → v${selectedRow.planVersion}`}
                  </span>
                  {state.phase === 'ready' && (
                    <span className="font-mono text-xs text-muted-foreground">
                      <span className="text-green-600 dark:text-green-400">
                        +{state.stats.additions}
                      </span>{' '}
                      <span className="text-red-600 dark:text-red-400">
                        −{state.stats.deletions}
                      </span>
                      {state.stats.modifications > 0 && <span> ~{state.stats.modifications}</span>}
                    </span>
                  )}
                </div>
                <div className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {selectedRow.note}
                </div>
              </div>
            )}
            <div className="px-5 py-4">
              {selected == null && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  왼쪽에서 버전을 선택하세요
                </div>
              )}
              {state.phase === 'loading' && selected != null && (
                <div className="py-12 text-center text-sm text-muted-foreground">diff 계산 중…</div>
              )}
              {state.phase === 'first-version' && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  최초 게시 버전이라 비교할 이전 버전이 없어요.
                </div>
              )}
              {state.phase === 'error' && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {state.message}
                </div>
              )}
              {state.phase === 'ready' && <PlanCleanDiffView blocks={state.blocks} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
