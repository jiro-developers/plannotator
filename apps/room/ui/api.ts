/**
 * Typed client for the room REST API + converters between the wire
 * RoomAnnotation and the viewer's Annotation shape.
 */

import type { Annotation } from '@plannotator/ui/types';
import { AnnotationType } from '@plannotator/ui/types';
import type {
  RoomAnnotation,
  RoomAnnotationInput,
  RoomAnnotationStatus,
  RoomAnnotationType,
  RoomSnapshot,
} from '../core/types';

const TYPE_TO_ENUM: Record<RoomAnnotationType, AnnotationType> = {
  DELETION: AnnotationType.DELETION,
  COMMENT: AnnotationType.COMMENT,
  GLOBAL_COMMENT: AnnotationType.GLOBAL_COMMENT,
};

const ENUM_TO_TYPE: Record<AnnotationType, RoomAnnotationType> = {
  [AnnotationType.DELETION]: 'DELETION',
  [AnnotationType.COMMENT]: 'COMMENT',
  [AnnotationType.GLOBAL_COMMENT]: 'GLOBAL_COMMENT',
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function fetchRoom(roomId: string): Promise<RoomSnapshot> {
  return request<RoomSnapshot>(`/api/rooms/${roomId}`);
}

/** A stored plan body for one version. 404s for versions predating history storage. */
export function fetchPlanVersion(
  roomId: string,
  planVersion: number
): Promise<{ planVersion: number; plan: string }> {
  return request<{ planVersion: number; plan: string }>(
    `/api/rooms/${roomId}/plan-versions/${planVersion}`
  );
}

/** `snapshot`은 변화 없음(HTTP 304)일 때 null. 에이전트 하트비트는 304에서도 헤더로 온다. */
export async function fetchChanges(
  roomId: string,
  since: number
): Promise<{ snapshot: RoomSnapshot | null; agentLastSeenA: number | null }> {
  const response = await fetch(`/api/rooms/${roomId}/changes?since=${since}`);
  const seenHeader = Number(response.headers.get('X-Agent-Last-Seen'));
  const agentLastSeenA = Number.isFinite(seenHeader) && seenHeader > 0 ? seenHeader : null;
  if (response.status === 304) return { snapshot: null, agentLastSeenA };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { snapshot: (await response.json()) as RoomSnapshot, agentLastSeenA };
}

export function createRoom(
  plan: string,
  title: string | undefined,
  author: string
): Promise<{ id: string; url: string; version: number }> {
  return request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ plan, title: title || undefined, author }),
  });
}

export function postAnnotation(
  roomId: string,
  input: RoomAnnotationInput
): Promise<{ annotation: RoomAnnotation; version: number }> {
  return request(`/api/rooms/${roomId}/annotations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function postReply(
  roomId: string,
  annotationId: string,
  author: string,
  text: string
): Promise<{ annotation: RoomAnnotation; version: number }> {
  return request(`/api/rooms/${roomId}/annotations/${annotationId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ author, text }),
  });
}

export function toggleVote(
  roomId: string,
  annotationId: string,
  author: string
): Promise<{ votes: string[]; version: number }> {
  return request(`/api/rooms/${roomId}/annotations/${annotationId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ author }),
  });
}

/** "문서 확인" 등록/취소. 인증 모드에선 세션 기준, 무인증 모드에선 author 필요. */
export function setAck(
  roomId: string,
  confirmed: boolean,
  author: string
): Promise<{ acks: import('../core/types').RoomAck[]; version: number }> {
  return request(`/api/rooms/${roomId}/acks`, {
    method: confirmed ? 'POST' : 'DELETE',
    body: JSON.stringify({ author }),
  });
}

export function patchAnnotation(
  roomId: string,
  annotationId: string,
  body: { author: string; status?: RoomAnnotationStatus; text?: string }
): Promise<{ annotation: RoomAnnotation; version: number }> {
  return request(`/api/rooms/${roomId}/annotations/${annotationId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteAnnotation(
  roomId: string,
  annotationId: string,
  author: string
): Promise<{ version: number }> {
  return request(`/api/rooms/${roomId}/annotations/${annotationId}`, {
    method: 'DELETE',
    body: JSON.stringify({ author }),
  });
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

export function toUiAnnotation(a: RoomAnnotation): Annotation {
  return {
    id: a.id,
    blockId: a.blockId ?? '',
    startOffset: a.startOffset ?? 0,
    endOffset: a.endOffset ?? 0,
    type: TYPE_TO_ENUM[a.type],
    text: a.text,
    originalText: a.originalText,
    createdA: a.createdA,
    author: a.author,
    startMeta: a.startMeta,
    endMeta: a.endMeta,
    isQuickLabel: a.isQuickLabel,
    quickLabelTip: a.quickLabelTip,
  };
}

export function toWireInput(a: Annotation, fallbackAuthor: string): RoomAnnotationInput {
  return {
    id: a.id,
    type: ENUM_TO_TYPE[a.type],
    originalText: a.originalText,
    text: a.text,
    author: a.author ?? fallbackAuthor,
    createdA: a.createdA,
    blockId: a.blockId || undefined,
    startOffset: a.startOffset,
    endOffset: a.endOffset,
    startMeta: a.startMeta,
    endMeta: a.endMeta,
    isQuickLabel: a.isQuickLabel,
    quickLabelTip: a.quickLabelTip,
  };
}

/** Optimistic local wire entry until the server-confirmed one arrives. */
export function toOptimisticRoomAnnotation(
  a: Annotation,
  fallbackAuthor: string,
  seq: number
): RoomAnnotation {
  return {
    ...toWireInput(a, fallbackAuthor),
    seq,
    votes: [],
    status: 'open',
    replies: [],
  };
}
