import { useEffect, useState } from 'react';
import { computePlanDiff, type PlanDiffBlock, type PlanDiffStats } from '@plannotator/ui/utils/planDiffEngine';
import { PlanCleanDiffView } from '@plannotator/ui/components/plan-diff/PlanCleanDiffView';
import { fetchPlanVersion } from './api';

interface ChangelogDiffModalProps {
  roomId: string;
  /** The version this changelog entry produced; diffs against planVersion - 1. */
  planVersion: number;
  onClose: () => void;
}

type DiffState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; blocks: PlanDiffBlock[]; stats: PlanDiffStats };

/** Overlay showing what changed between a plan version and its predecessor. */
export function ChangelogDiffModal({ roomId, planVersion, onClose }: ChangelogDiffModalProps) {
  const [state, setState] = useState<DiffState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPlanVersion(roomId, planVersion - 1), fetchPlanVersion(roomId, planVersion)])
      .then(([prev, next]) => {
        if (cancelled) return;
        const { blocks, stats } = computePlanDiff(prev.plan, next.plan);
        setState({ phase: 'ready', blocks, stats });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message =
          e instanceof Error && e.message === 'Version not found'
            ? '이 버전의 원문이 저장되어 있지 않아요 (버전 기록 기능이 추가되기 전의 변경입니다)'
            : e instanceof Error
              ? e.message
              : '버전을 불러오지 못했어요';
        setState({ phase: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, planVersion]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`플랜 v${planVersion - 1} → v${planVersion} 변경 내용`}
    >
      <div
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
          <span className="text-sm font-semibold">
            plan v{planVersion - 1} → v{planVersion}
          </span>
          {state.phase === 'ready' && (
            <span className="font-mono text-xs text-muted-foreground">
              <span className="text-green-600 dark:text-green-400">+{state.stats.additions}</span>{' '}
              <span className="text-red-600 dark:text-red-400">−{state.stats.deletions}</span>{' '}
              {state.stats.modifications > 0 && <span>~{state.stats.modifications}</span>}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            닫기 (Esc)
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {state.phase === 'loading' && (
            <div className="py-12 text-center text-sm text-muted-foreground">diff 계산 중…</div>
          )}
          {state.phase === 'error' && (
            <div className="py-12 text-center text-sm text-muted-foreground">{state.message}</div>
          )}
          {state.phase === 'ready' && <PlanCleanDiffView blocks={state.blocks} />}
        </div>
      </div>
    </div>
  );
}
