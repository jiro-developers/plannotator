import { homedir } from 'os';
import { join } from 'path';
import { DEFAULT_MAX_PLAN_SIZE, handleRoomRequest } from '../core/handler';
import { corsHeaders, getAllowedOrigins } from '../core/cors';
import type { RoomStore } from '../core/storage';
import { FsRoomStore } from '../stores/fs';
import { PostgresRoomStore } from '../stores/postgres';
import { FAVICON_PNG_BYTES } from '@plannotator/core/favicon';

const port = parseInt(process.env.PORT || process.env.ROOM_PORT || '19434', 10);
const ttlDays = parseInt(process.env.ROOM_TTL_DAYS || '90', 10);
const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
const maxPlanSize = parseInt(process.env.ROOM_MAX_PLAN_SIZE || String(DEFAULT_MAX_PLAN_SIZE), 10);
const allowedOrigins = getAllowedOrigins(process.env.ROOM_ALLOWED_ORIGINS);
const publicBaseUrl = process.env.ROOM_PUBLIC_URL?.replace(/\/$/, '');
const databaseUrl = process.env.DATABASE_URL;

// Google 로그인은 세 변수가 모두 있어야 켜진다 — 없으면 기존 무인증 모드.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const sessionSecret = process.env.ROOM_SESSION_SECRET;
const auth =
  googleClientId && googleClientSecret && sessionSecret
    ? {
        googleClientId,
        googleClientSecret,
        sessionSecret,
        allowedDomain: process.env.ROOM_ALLOWED_EMAIL_DOMAIN || 'jirocorp.io',
        agentToken: process.env.ROOM_AGENT_TOKEN || undefined,
      }
    : undefined;

const store: RoomStore = databaseUrl
  ? new PostgresRoomStore(databaseUrl, ttlMs)
  : new FsRoomStore(
      process.env.ROOM_DATA_DIR || join(homedir(), '.plannotator', 'rooms'),
      ttlMs
    );

// The SPA is a single self-contained HTML file (vite-plugin-singlefile),
// read lazily so `bun run dev` (API only) works before the first build.
const appHtmlPath = new URL('../dist/index.html', import.meta.url).pathname;
let appHtml: string | null = null;

async function serveApp(): Promise<Response> {
  if (appHtml === null) {
    try {
      appHtml = await Bun.file(appHtmlPath).text();
    } catch {
      return new Response(
        'Room UI not built yet. Run: bun run --cwd apps/room build',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
  }
  return new Response(appHtml, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.png') {
      return new Response(FAVICON_PNG_BYTES.slice().buffer as ArrayBuffer, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    }
    const origin = request.headers.get('Origin') ?? '';
    const cors = corsHeaders(origin, allowedOrigins);
    return handleRoomRequest(request, store, cors, { maxPlanSize, publicBaseUrl, auth }, serveApp);
  },
});

console.log(`Plannotator room service running on http://localhost:${port}`);
console.log(`Storage: ${databaseUrl ? 'postgres (DATABASE_URL)' : 'filesystem'}`);
console.log(`Room TTL: ${ttlDays} days`);
console.log(
  auth
    ? `Auth: google (@${auth.allowedDomain}${auth.agentToken ? ', agent token set' : ', NO agent token'})`
    : 'Auth: disabled (no GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/ROOM_SESSION_SECRET)'
);
