import { useEffect, useState, type ReactNode } from 'react';
import { setIdentityProvider } from '@plannotator/ui/utils/identity';

/**
 * Set while a Google session is active: renames the session's display name
 * server-side (cookie reissue) and updates the identity provider. Null in
 * no-auth mode — callers fall back to the tater cookie rename.
 */
let authedRename: ((name: string) => Promise<void>) | null = null;
export function getAuthedRename() {
  return authedRename;
}

/**
 * Blocks the app behind Google login when the server has auth enabled.
 *
 * - `/api/me` 200 {auth:false} → auth disabled, render children (tater identity)
 * - 200 {auth:true, user}      → stamp the Google name as the identity
 *                                (read-only — no rename) and render children
 * - 401                        → show the login screen
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<'loading' | 'anon' | 'ready'>('loading');
  /** 서버가 알려주는 로그인 허용 도메인 (하드코딩하지 않는다). */
  const [allowedDomain, setAllowedDomain] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then(async (response) => {
        if (response.status === 401) {
          try {
            const body = (await response.json()) as { domain?: string };
            if (body.domain) setAllowedDomain(body.domain);
          } catch {
            // 도메인 안내 없이 로그인 화면만 보여준다
          }
          setPhase('anon');
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const me = (await response.json()) as {
          auth: boolean;
          user?: { email: string; name: string };
        };
        if (me.auth && me.user) {
          let name = me.user.name;
          setIdentityProvider({
            getIdentity: () => name,
            isCurrentUser: (author) => author === name,
            isEditable: () => true,
          });
          authedRename = async (next: string) => {
            const res = await fetch('/api/me/name', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: next }),
            });
            if (!res.ok) {
              let message = `HTTP ${res.status}`;
              try {
                const body = (await res.json()) as { error?: string };
                if (body.error) message = body.error;
              } catch {}
              throw new Error(message);
            }
            name = next;
          };
        }
        setPhase('ready');
      })
      .catch(() => {
        // Server unreachable or legacy build without /api/me — let the app
        // render; API calls will surface their own errors.
        setPhase('ready');
      });
  }, []);

  if (phase === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        확인 중…
      </div>
    );
  }

  if (phase === 'anon') {
    const redirect = encodeURIComponent(window.location.pathname);
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className="text-xl font-semibold text-foreground">Plannotator Room</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          팀 전용 공간이에요. 회사 Google 계정으로 로그인하면 코멘트에 실명이 표시됩니다.
        </p>
        <a
          href={`/auth/login?redirect=${redirect}`}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
        >
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Google로 로그인
        </a>
        {allowedDomain && (
          <p className="text-xs text-muted-foreground">{allowedDomain} 계정만 입장할 수 있어요</p>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
