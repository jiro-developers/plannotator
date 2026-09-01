/**
 * Google OAuth login + stateless HMAC-signed session cookies.
 *
 * Enabled when the server is configured with a Google OAuth client and a
 * session secret. Only accounts on the allowed Workspace domain (checked via
 * the id_token's `hd` claim + verified email suffix) may log in. Agents
 * authenticate with a shared bearer token instead (they cannot do OAuth).
 *
 * Sessions are self-contained (no server-side store): the cookie carries
 * `v1.<b64url(payload)>.<b64url(hmac-sha256)>` where payload = {e,n,x}.
 */

export interface RoomAuthConfig {
  googleClientId: string;
  googleClientSecret: string;
  /** HMAC key for session cookies. */
  sessionSecret: string;
  /** Workspace domain allowed to log in, e.g. "jirocorp.io". */
  allowedDomain: string;
  /** Shared bearer token for agent (REST) access. Optional. */
  agentToken?: string;
}

export interface SessionUser {
  email: string;
  name: string;
}

const SESSION_COOKIE = 'room_session';
const STATE_COOKIE = 'room_oauth_state';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const STATE_TTL_S = 600;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array | null {
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export async function createSessionCookie(user: SessionUser, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ e: user.email, n: user.name, x: Date.now() + SESSION_TTL_MS })));
  const sig = b64url(await hmac(secret, payload));
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=v1.${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function verifySession(request: Request, secret: string): Promise<SessionUser | null> {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = await hmac(secret, parts[1]);
  const given = b64urlDecode(parts[2]);
  if (!given || !timingSafeEqual(expected, given)) return null;
  const payloadBytes = b64urlDecode(parts[1]);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { e: string; n: string; x: number };
    if (typeof payload.x !== 'number' || payload.x < Date.now()) return null;
    if (typeof payload.e !== 'string' || typeof payload.n !== 'string') return null;
    return { email: payload.e, name: payload.n };
  } catch {
    return null;
  }
}

/** Agent bearer-token check: `Authorization: Bearer <agentToken>`. */
export function isAgentRequest(request: Request, auth: RoomAuthConfig): boolean {
  if (!auth.agentToken) return false;
  const header = request.headers.get('Authorization') ?? '';
  return header === `Bearer ${auth.agentToken}`;
}

// ---------------------------------------------------------------------------
// Google OAuth code flow
// ---------------------------------------------------------------------------

export function buildStateCookie(state: string, redirectPath: string): string {
  const value = b64url(enc.encode(JSON.stringify({ s: state, r: redirectPath })));
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_S}`;
}

export function readStateCookie(request: Request): { s: string; r: string } | null {
  const raw = readCookie(request, STATE_COOKIE);
  if (!raw) return null;
  const bytes = b64urlDecode(raw);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { s?: string; r?: string };
    if (typeof parsed.s !== 'string') return null;
    return { s: parsed.s, r: typeof parsed.r === 'string' && parsed.r.startsWith('/') ? parsed.r : '/' };
  } catch {
    return null;
  }
}

export const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function googleAuthUrl(auth: RoomAuthConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: auth.googleClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    hd: auth.allowedDomain, // UI hint only — the callback re-verifies
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange the authorization code and validate the account. The id_token comes
 * straight from Google's token endpoint over TLS, so decoding its payload
 * without signature verification is sound here.
 */
export async function exchangeGoogleCode(
  auth: RoomAuthConfig,
  redirectUri: string,
  code: string
): Promise<SessionUser | { error: string }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: auth.googleClientId,
      client_secret: auth.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) return { error: `token exchange failed (${response.status})` };
  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) return { error: 'no id_token in response' };

  const segments = tokens.id_token.split('.');
  if (segments.length !== 3) return { error: 'malformed id_token' };
  const claimBytes = b64urlDecode(segments[1]);
  if (!claimBytes) return { error: 'malformed id_token payload' };
  let claims: { email?: string; email_verified?: boolean; hd?: string; name?: string };
  try {
    claims = JSON.parse(new TextDecoder().decode(claimBytes));
  } catch {
    return { error: 'malformed id_token payload' };
  }

  const email = claims.email ?? '';
  const domainOk =
    claims.hd === auth.allowedDomain && email.toLowerCase().endsWith(`@${auth.allowedDomain}`);
  if (!claims.email_verified || !domainOk) {
    return { error: `${auth.allowedDomain} 계정만 로그인할 수 있어요` };
  }
  return { email, name: claims.name?.trim() || email.split('@')[0] };
}
