import { useState } from 'react';
import type { RoomAnnotation, RoomAnnotationStatus } from '../core/types';

const STATUS_LABEL: Record<RoomAnnotationStatus, string | null> = {
  open: null,
  answered: '답변됨',
  reflected: '반영됨',
  declined: '보류',
};

const STATUS_CLASS: Record<RoomAnnotationStatus, string> = {
  open: '',
  answered: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  reflected: 'bg-green-500/10 text-green-600 dark:text-green-400',
  declined: 'bg-muted text-muted-foreground',
};

interface RoomCardFooterProps {
  annotation: RoomAnnotation;
  identity: string;
  /** The annotation's originalText no longer exists in the current plan. */
  anchorLost?: boolean;
  onVote: (annotationId: string) => void;
  onReply: (annotationId: string, text: string) => Promise<void>;
}

/**
 * Collaboration footer rendered inside each AnnotationPanel card:
 * vote toggle, agent/owner status badge, replies thread, reply input.
 */
export function RoomCardFooter({ annotation, identity, anchorLost, onVote, onReply }: RoomCardFooterProps) {
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [showReplyInput, setShowReplyInput] = useState(false);

  const voted = annotation.votes.includes(identity);
  const statusLabel = STATUS_LABEL[annotation.status];

  const submitReply = async () => {
    const text = replyText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onReply(annotation.id, text);
      setReplyText('');
      setShowReplyInput(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2 border-t border-border/40 pt-2 space-y-2 text-xs">
      {anchorLost && (
        <div className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">
          문서가 갱신되어 본문에서 위치를 표시할 수 없어요 (위의 인용 원문 참고)
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onVote(annotation.id)}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
            voted
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border/60 text-muted-foreground hover:bg-muted'
          }`}
          title={voted ? '승인 취소' : '승인 (approve)'}
        >
          <span aria-hidden>👍</span>
          <span className="tabular-nums">{annotation.votes.length}</span>
        </button>
        {statusLabel && (
          <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_CLASS[annotation.status]}`}>
            {statusLabel}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowReplyInput((v) => !v)}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          답글
        </button>
      </div>

      {annotation.votes.length > 0 && (
        <div className="text-[11px] text-muted-foreground truncate" title={annotation.votes.join(', ')}>
          승인: {annotation.votes.join(', ')}
        </div>
      )}

      {annotation.replies.length > 0 && (
        <div className="space-y-1.5">
          {annotation.replies.map((reply, index) => {
            const isAgent = reply.author === 'agent';
            return (
              <div
                key={index}
                className={`rounded-md border px-2.5 py-2 ${
                  isAgent ? 'border-primary/30 bg-primary/5' : 'border-border/60 bg-background/70'
                }`}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  {isAgent ? (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                      Agent
                    </span>
                  ) : (
                    <span className="text-[11px] font-semibold text-foreground">{reply.author}</span>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(reply.createdA).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="whitespace-pre-wrap break-words text-foreground">{reply.text}</div>
              </div>
            );
          })}
        </div>
      )}

      {showReplyInput && (
        <div className="flex items-end gap-1.5">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submitReply();
              }
            }}
            rows={2}
            placeholder="답글 입력… (⌘+Enter 전송)"
            className="min-w-0 flex-1 resize-none rounded border border-border/60 bg-background px-2 py-1 text-xs outline-none focus:border-primary/50"
          />
          <button
            type="button"
            onClick={() => void submitReply()}
            disabled={sending || !replyText.trim()}
            className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
          >
            전송
          </button>
        </div>
      )}
    </div>
  );
}
