import { useMemo, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { getIdentity } from '@plannotator/ui/utils/identity';
import { createRoom } from './api';

/**
 * Minimal landing page: paste a plan markdown, get a shareable room link.
 * Agents normally create rooms via POST /api/rooms instead.
 */
export function LandingApp() {
  const [title, setTitle] = useState('');
  const [plan, setPlan] = useState('');
  const [creating, setCreating] = useState(false);
  const identity = useMemo(() => getIdentity(), []);

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
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-10">
      <div>
        <h1 className="text-xl font-bold text-foreground">Plannotator Room</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          플랜 마크다운을 붙여넣고 방을 만들면, 링크 하나로 팀원들과 인라인 코멘트를 공유할 수
          있어요. 에이전트는 REST API(<code className="font-mono text-xs">/api/rooms</code>)로 방을
          만들고 폴링합니다.
        </p>
      </div>
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
        rows={18}
        className="resize-y rounded border border-border/60 bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !plan.trim()}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {creating ? '생성 중…' : '방 만들기'}
        </button>
        <span className="text-xs text-muted-foreground">내 닉네임: {identity}</span>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
