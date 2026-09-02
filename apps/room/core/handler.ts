/**
 * Runtime-agnostic HTTP handler for the Plan Room service.
 *
 * Routes (all JSON unless noted):
 *   POST   /api/rooms                                  create a room from {plan, title?}
 *   GET    /api/rooms/:id                              full snapshot
 *   GET    /api/rooms/:id/changes?since=<version>      304 when unchanged, snapshot otherwise
 *   PUT    /api/rooms/:id/plan                         {plan, note?, author?} → new plan version
 *   POST   /api/rooms/:id/annotations                  add an annotation (client-generated id)
 *   POST   /api/rooms/:id/annotations/:aid/replies     {author, text}
 *   POST   /api/rooms/:id/annotations/:aid/vote        {author} — toggles the author's vote
 *   PATCH  /api/rooms/:id/annotations/:aid             {status?, text?, author}
 *   DELETE /api/rooms/:id/annotations/:aid             {author} — only the author may delete
 *   POST   /api/config                                 204 (viewer identity write-back — ignored)
 *   GET    /healthz                                    ok
 *
 * Anything else GET → the SPA (delegated to the target via `serveApp`).
 * No auth by design (MVP): the shortcode is the only secret. Run this on a
 * private network.
 */

import type { RoomStore } from './storage';
import type {
  RoomAnnotation,
  RoomAnnotationInput,
  RoomAnnotationStatus,
  RoomAnnotationTextMeta,
  RoomDoc,
} from './types';
import { toSnapshot } from './types';
import {
  type RoomAuthConfig,
  type SessionUser,
  verifySession,
  isAgentRequest,
  createSessionCookie,
  CLEAR_SESSION_COOKIE,
  buildStateCookie,
  readStateCookie,
  CLEAR_STATE_COOKIE,
  googleAuthUrl,
  exchangeGoogleCode,
} from './auth';

export interface RoomServiceOptions {
  /** Max plan markdown size in bytes. */
  maxPlanSize: number;
  /** Base URL used to build shareable room links (e.g. https://room.example.com). */
  publicBaseUrl?: string;
  /** When set, Google login (domain-restricted) gates every /api/rooms route. */
  auth?: RoomAuthConfig;
}

export const DEFAULT_MAX_PLAN_SIZE = 2 * 1024 * 1024;

const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9]{6,16})(\/.*)?$/;
const ANNOTATION_SUBPATH = /^\/annotations\/([A-Za-z0-9._:-]{1,128})(\/(replies|vote))?$/;

const ANNOTATION_TYPE_LIST = ['DELETION', 'COMMENT', 'GLOBAL_COMMENT'] as const;
const ANNOTATION_STATUS_LIST: RoomAnnotationStatus[] = ['open', 'answered', 'reflected', 'declined'];

const MAX_TEXT_LENGTH = 20_000;
const MAX_AUTHOR_LENGTH = 120;
const MAX_TITLE_LENGTH = 300;
/** Superseded plan bodies kept per room for the history diff view. */
const MAX_PLAN_HISTORY = 50;

export class RoomError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/** Short URL-safe id — same rejection-sampled scheme as the paste service. */
export function generateRoomId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const limit = 256 - (256 % chars.length);
  const id: string[] = [];
  while (id.length < 8) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit) {
        id.push(chars[b % chars.length]);
        if (id.length === 8) break;
      }
    }
  }
  return id.join('');
}

// ---------------------------------------------------------------------------
// Validation — narrow unknown JSON into typed inputs, reject anything odd.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RoomError(`Missing or invalid "${field}"`, 400);
  }
  if (value.length > maxLength) {
    throw new RoomError(`"${field}" exceeds max length ${maxLength}`, 413);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, maxLength);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseTextMeta(value: unknown): RoomAnnotationTextMeta | undefined {
  if (!isRecord(value)) return undefined;
  const { parentTagName, parentIndex, textOffset } = value;
  if (
    typeof parentTagName !== 'string' ||
    typeof parentIndex !== 'number' ||
    typeof textOffset !== 'number'
  ) {
    return undefined;
  }
  return { parentTagName, parentIndex, textOffset };
}

function parseAnnotationInput(body: unknown): RoomAnnotationInput {
  if (!isRecord(body)) {
    throw new RoomError('Invalid annotation body', 400);
  }
  const type = body.type;
  if (typeof type !== 'string' || !(ANNOTATION_TYPE_LIST as readonly string[]).includes(type)) {
    throw new RoomError(`"type" must be one of ${ANNOTATION_TYPE_LIST.join(', ')}`, 400);
  }
  const originalText = typeof body.originalText === 'string' ? body.originalText : '';
  if (type !== 'GLOBAL_COMMENT' && originalText.length === 0) {
    throw new RoomError('"originalText" is required for anchored annotations', 400);
  }
  if (originalText.length > MAX_TEXT_LENGTH) {
    throw new RoomError('"originalText" too large', 413);
  }
  return {
    id: requireString(body.id, 'id', 128),
    type: type as RoomAnnotationInput['type'],
    originalText,
    text: optionalString(body.text, 'text', MAX_TEXT_LENGTH),
    author: requireString(body.author, 'author', MAX_AUTHOR_LENGTH),
    createdA: optionalNumber(body.createdA) ?? Date.now(),
    blockId: optionalString(body.blockId, 'blockId', 256),
    startOffset: optionalNumber(body.startOffset),
    endOffset: optionalNumber(body.endOffset),
    startMeta: parseTextMeta(body.startMeta),
    endMeta: parseTextMeta(body.endMeta),
    isQuickLabel: typeof body.isQuickLabel === 'boolean' ? body.isQuickLabel : undefined,
    quickLabelTip: optionalString(body.quickLabelTip, 'quickLabelTip', 2000),
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RoomError('Invalid JSON body', 400);
  }
  if (!isRecord(body)) {
    throw new RoomError('Body must be a JSON object', 400);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Per-room mutation serialization — read-modify-write cycles on the same room
// must not interleave (single-process assumption; scale-out needs a real DB
// transaction instead).
// ---------------------------------------------------------------------------

const roomLocks = new Map<string, Promise<unknown>>();

async function withRoomLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = roomLocks.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  roomLocks.set(id, tail);
  try {
    return await run;
  } finally {
    if (roomLocks.get(id) === tail) {
      roomLocks.delete(id);
    }
  }
}

async function loadRoom(store: RoomStore, id: string): Promise<RoomDoc> {
  const doc = await store.get(id);
  if (!doc) {
    throw new RoomError('Room not found', 404);
  }
  return doc;
}

function findAnnotation(doc: RoomDoc, annotationId: string): RoomAnnotation {
  const annotation = doc.annotations.find((a) => a.id === annotationId);
  if (!annotation) {
    throw new RoomError('Annotation not found', 404);
  }
  return annotation;
}

function touch(doc: RoomDoc): void {
  doc.version += 1;
  doc.updatedA = Date.now();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRoomRequest(
  request: Request,
  store: RoomStore,
  cors: Record<string, string>,
  options: RoomServiceOptions,
  serveApp: () => Promise<Response>
): Promise<Response> {
  const url = new URL(request.url);
  const json = (data: unknown, status = 200): Response =>
    Response.json(data, { status, headers: cors });

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/healthz') {
      return json({ ok: true });
    }

    // Canonical-domain redirect: with a public URL configured, requests on any
    // other host (e.g. the *.railway.app alias) bounce to it. Cookies are
    // per-domain, so letting users log in on an alias would strand the OAuth
    // state/session cookies there and break the callback.
    if (options.publicBaseUrl) {
      const canonicalHost = new URL(options.publicBaseUrl).host;
      if (url.host !== canonicalHost && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        return new Response(null, {
          status: 301,
          headers: { Location: `${options.publicBaseUrl}${url.pathname}${url.search}` },
        });
      }
    }

    // The viewer's identity/config write-back — accept and discard so the
    // shared @plannotator/ui config store never sees console errors.
    if (url.pathname === '/api/config') {
      if (request.method === 'POST') {
        return new Response(null, { status: 204, headers: cors });
      }
      return json({}, 200);
    }

    const auth = options.auth;
    const baseOrigin = options.publicBaseUrl ?? url.origin;

    if (auth) {
      if (url.pathname === '/auth/login' && request.method === 'GET') {
        const redirect = url.searchParams.get('redirect') ?? '/';
        const safeRedirect = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/';
        const state = crypto.randomUUID();
        const headers = new Headers(cors);
        headers.set('Location', googleAuthUrl(auth, `${baseOrigin}/auth/callback`, state));
        headers.append('Set-Cookie', buildStateCookie(state, safeRedirect));
        return new Response(null, { status: 302, headers });
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const saved = readStateCookie(request);
        if (!code || !state || !saved || saved.s !== state) {
          return new Response('로그인 상태가 만료됐어요. 다시 시도해 주세요.', {
            status: 400,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        const result = await exchangeGoogleCode(auth, `${baseOrigin}/auth/callback`, code);
        if ('error' in result) {
          return new Response(`로그인 실패: ${result.error}`, {
            status: 403,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        const headers = new Headers();
        headers.set('Location', saved.r);
        headers.append('Set-Cookie', await createSessionCookie(result, auth.sessionSecret));
        headers.append('Set-Cookie', CLEAR_STATE_COOKIE);
        return new Response(null, { status: 302, headers });
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        const headers = new Headers(cors);
        headers.append('Set-Cookie', CLEAR_SESSION_COOKIE);
        return new Response(null, { status: 204, headers });
      }
    }

    // Who is calling: a logged-in browser session or the shared agent token.
    // Their name is stamped as `author` on every mutation (no impersonation).
    let actor: SessionUser | null = null;
    if (auth) {
      actor = isAgentRequest(request, auth)
        ? { email: 'agent', name: 'agent' }
        : await verifySession(request, auth.sessionSecret);
    }
    const actorName = actor?.name ?? null;

    if (url.pathname === '/api/me') {
      if (!auth) return json({ auth: false });
      if (!actor) return json({ error: 'Unauthorized' }, 401);
      return json({ auth: true, user: { email: actor.email, name: actor.name } });
    }

    // 표시 이름 변경: 이메일(실계정)은 그대로 두고 세션 쿠키를 새 이름으로
    // 재발급한다. author 스탬프가 세션 이름을 쓰므로 서버가 곧바로 존중한다.
    if (auth && url.pathname === '/api/me/name' && request.method === 'POST') {
      const session = await verifySession(request, auth.sessionSecret);
      if (!session) return json({ error: 'Unauthorized' }, 401);
      const body = await readJson(request);
      const name = requireString(body.name, 'name', MAX_AUTHOR_LENGTH).trim();
      if (!name) return json({ error: '이름을 입력해 주세요' }, 400);
      if (name.toLowerCase() === 'agent') return json({ error: '"agent"는 예약된 이름이에요' }, 400);
      const headers = new Headers(cors);
      headers.set('Content-Type', 'application/json');
      headers.append('Set-Cookie', await createSessionCookie({ email: session.email, name }, auth.sessionSecret));
      return new Response(JSON.stringify({ user: { email: session.email, name } }), { status: 200, headers });
    }

    if (auth && url.pathname.startsWith('/api/rooms') && !actor) {
      return json({ error: 'Unauthorized' }, 401);
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await readJson(request);
      const plan = requireString(body.plan, 'plan', options.maxPlanSize);
      const title = optionalString(body.title, 'title', MAX_TITLE_LENGTH) ?? deriveTitle(plan);
      const author = actorName ?? optionalString(body.author, 'author', MAX_AUTHOR_LENGTH) ?? 'owner';
      const now = Date.now();
      const id = generateRoomId();
      const doc: RoomDoc = {
        id,
        title,
        plan,
        planVersion: 1,
        version: 1,
        seqCounter: 0,
        createdA: now,
        updatedA: now,
        annotations: [],
        changelog: [{ version: 1, planVersion: 1, note: 'Room created', author, createdA: now }],
      };
      await store.put(id, doc);
      const base = options.publicBaseUrl ?? url.origin;
      return json({ id, url: `${base}/r/${id}`, version: doc.version }, 201);
    }

    const roomMatch = url.pathname.match(ROOM_PATH);
    if (roomMatch) {
      const roomId = roomMatch[1];
      const subPath = roomMatch[2] ?? '';

      if (request.method === 'GET' && subPath === '') {
        const doc = await loadRoom(store, roomId);
        return json(toSnapshot(doc));
      }

      // Commit-request signal: a teammate asks the agent to commit accumulated
      // plan changes. POST raises it (idempotent), DELETE clears it (agent ack).
      if (subPath === '/signals/commit') {
        if (request.method === 'POST') {
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            doc.signals ??= {};
            doc.signals.commitRequestedA = Date.now();
            if (actorName) doc.signals.commitRequestedBy = actorName;
            touch(doc);
            await store.put(roomId, doc);
            return json({ signals: doc.signals, version: doc.version });
          });
        }
        if (request.method === 'DELETE') {
          // The agent reports "committed up to the current planVersion" —
          // clears any pending request and hides the commit button until the
          // plan changes again. Called after every commit, requested or not.
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            doc.signals ??= {};
            delete doc.signals.commitRequestedA;
            delete doc.signals.commitRequestedBy;
            doc.signals.lastCommittedPlanVersion = doc.planVersion;
            touch(doc);
            await store.put(roomId, doc);
            return json({ signals: doc.signals, version: doc.version });
          });
        }
      }

      // Document acknowledgement ("문서 확인"): one record per user, keyed by a
      // stable id (login email > display name) so a rename keeps the same ack.
      if (subPath === '/acks') {
        // The agent has no "read" concept — humans only.
        const ackKey = actor && actor.email !== 'agent' ? actor.email : actorName;
        const ackName = actorName;
        if (request.method === 'POST') {
          const body = await readJson(request).catch(() => ({}));
          // Auth on: use the session. Auth off (local dev): trust the client author.
          const key = ackKey ?? optionalString((body as { author?: unknown }).author, 'author', MAX_AUTHOR_LENGTH);
          const name = ackName ?? key;
          if (!key || !name) return json({ error: 'Unauthorized' }, 401);
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            doc.acks ??= [];
            const existing = doc.acks.find((a) => a.key === key);
            if (existing) {
              existing.name = name;
              existing.planVersion = doc.planVersion;
              existing.createdA = Date.now();
            } else {
              doc.acks.push({ key, name, planVersion: doc.planVersion, createdA: Date.now() });
            }
            touch(doc);
            await store.put(roomId, doc);
            return json({ acks: doc.acks, version: doc.version });
          });
        }
        if (request.method === 'DELETE') {
          const body = await readJson(request).catch(() => ({}));
          const key = ackKey ?? optionalString((body as { author?: unknown }).author, 'author', MAX_AUTHOR_LENGTH);
          if (!key) return json({ error: 'Unauthorized' }, 401);
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            if (doc.acks?.some((a) => a.key === key)) {
              doc.acks = doc.acks.filter((a) => a.key !== key);
              touch(doc);
              await store.put(roomId, doc);
            }
            return json({ acks: doc.acks ?? [], version: doc.version });
          });
        }
      }

      const planVersionMatch = subPath.match(/^\/plan-versions\/(\d+)$/);
      if (request.method === 'GET' && planVersionMatch) {
        const doc = await loadRoom(store, roomId);
        const v = Number.parseInt(planVersionMatch[1], 10);
        if (v === doc.planVersion) {
          return json({ planVersion: v, plan: doc.plan, createdA: doc.updatedA });
        }
        const stored = (doc.planHistory ?? []).find((entry) => entry.planVersion === v);
        if (!stored) return json({ error: 'Version not found' }, 404);
        return json(stored);
      }

      if (request.method === 'GET' && subPath === '/changes') {
        const doc = await loadRoom(store, roomId);
        // Agent heartbeat: record the poll time without bumping `version`
        // (a version bump would make the agent see its own poll as a change).
        if (actor?.name === 'agent') {
          doc.agentLastSeenA = Date.now();
          await store.put(roomId, doc);
        }
        const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
        const heartbeatHeaders: Record<string, string> = doc.agentLastSeenA
          ? { ...cors, 'X-Agent-Last-Seen': String(doc.agentLastSeenA) }
          : cors;
        if (Number.isFinite(since) && since >= doc.version) {
          return new Response(null, { status: 304, headers: heartbeatHeaders });
        }
        return Response.json(toSnapshot(doc), { headers: heartbeatHeaders });
      }

      if (request.method === 'PUT' && subPath === '/plan') {
        const body = await readJson(request);
        const plan = requireString(body.plan, 'plan', options.maxPlanSize);
        const note = optionalString(body.note, 'note', 2000) ?? 'Plan updated';
        const author = actorName ?? optionalString(body.author, 'author', MAX_AUTHOR_LENGTH) ?? 'agent';
        return await withRoomLock(roomId, async () => {
          const doc = await loadRoom(store, roomId);
          // Keep the superseded body so the UI can diff versions (bounded).
          doc.planHistory ??= [];
          doc.planHistory.push({ planVersion: doc.planVersion, plan: doc.plan, createdA: doc.updatedA });
          while (doc.planHistory.length > MAX_PLAN_HISTORY) doc.planHistory.shift();
          doc.plan = plan;
          doc.planVersion += 1;
          touch(doc);
          doc.changelog.push({
            version: doc.version,
            planVersion: doc.planVersion,
            note,
            author,
            createdA: doc.updatedA,
          });
          await store.put(roomId, doc);
          return json({ planVersion: doc.planVersion, version: doc.version });
        });
      }

      if (request.method === 'POST' && subPath === '/annotations') {
        const input = parseAnnotationInput(await readJson(request));
        if (actorName) input.author = actorName;
        return await withRoomLock(roomId, async () => {
          const doc = await loadRoom(store, roomId);
          if (doc.annotations.some((a) => a.id === input.id)) {
            throw new RoomError('Annotation id already exists', 409);
          }
          doc.seqCounter += 1;
          const annotation: RoomAnnotation = {
            ...input,
            seq: doc.seqCounter,
            votes: [],
            status: 'open',
            replies: [],
          };
          doc.annotations.push(annotation);
          touch(doc);
          await store.put(roomId, doc);
          return json({ annotation, version: doc.version }, 201);
        });
      }

      const annotationMatch = subPath.match(ANNOTATION_SUBPATH);
      if (annotationMatch) {
        const annotationId = annotationMatch[1];
        const action = annotationMatch[3];

        if (request.method === 'POST' && action === 'replies') {
          const body = await readJson(request);
          const author = actorName ?? requireString(body.author, 'author', MAX_AUTHOR_LENGTH);
          const text = requireString(body.text, 'text', MAX_TEXT_LENGTH);
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            const annotation = findAnnotation(doc, annotationId);
            annotation.replies.push({ author, text, createdA: Date.now() });
            touch(doc);
            await store.put(roomId, doc);
            return json({ annotation, version: doc.version }, 201);
          });
        }

        if (request.method === 'POST' && action === 'vote') {
          const body = await readJson(request);
          const author = actorName ?? requireString(body.author, 'author', MAX_AUTHOR_LENGTH);
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            const annotation = findAnnotation(doc, annotationId);
            const index = annotation.votes.indexOf(author);
            if (index >= 0) {
              annotation.votes.splice(index, 1);
            } else {
              annotation.votes.push(author);
            }
            touch(doc);
            await store.put(roomId, doc);
            return json({ votes: annotation.votes, version: doc.version });
          });
        }

        if (request.method === 'PATCH' && action === undefined) {
          const body = await readJson(request);
          const author = actorName ?? requireString(body.author, 'author', MAX_AUTHOR_LENGTH);
          const status = optionalString(body.status, 'status', 32);
          const text = optionalString(body.text, 'text', MAX_TEXT_LENGTH);
          if (status !== undefined && !ANNOTATION_STATUS_LIST.includes(status as RoomAnnotationStatus)) {
            throw new RoomError(`"status" must be one of ${ANNOTATION_STATUS_LIST.join(', ')}`, 400);
          }
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            const annotation = findAnnotation(doc, annotationId);
            // Body text edits are author-only; status transitions are open to
            // everyone (the agent marks reflected/answered, the owner declines).
            if (text !== undefined) {
              if (annotation.author !== author) {
                throw new RoomError('Only the author may edit the annotation text', 403);
              }
              annotation.text = text;
            }
            if (status !== undefined) {
              annotation.status = status as RoomAnnotationStatus;
            }
            touch(doc);
            await store.put(roomId, doc);
            return json({ annotation, version: doc.version });
          });
        }

        if (request.method === 'DELETE' && action === undefined) {
          const body = await readJson(request);
          const author = actorName ?? requireString(body.author, 'author', MAX_AUTHOR_LENGTH);
          return await withRoomLock(roomId, async () => {
            const doc = await loadRoom(store, roomId);
            const annotation = findAnnotation(doc, annotationId);
            if (annotation.author !== author) {
              throw new RoomError('Only the author may delete the annotation', 403);
            }
            doc.annotations = doc.annotations.filter((a) => a.id !== annotationId);
            touch(doc);
            await store.put(roomId, doc);
            return json({ version: doc.version });
          });
        }
      }

      return json({ error: 'Not found' }, 404);
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }

    if (request.method === 'GET') {
      return serveApp();
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof RoomError) {
      return json({ error: e.message }, e.status);
    }
    console.error('[room] unhandled error:', e);
    return json({ error: 'Internal server error' }, 500);
  }
}

/** First markdown heading (or first non-empty line) as the default title. */
function deriveTitle(plan: string): string {
  for (const line of plan.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    const title = (heading ? heading[1] : trimmed).slice(0, MAX_TITLE_LENGTH);
    if (title) return title;
  }
  return 'Untitled plan';
}
