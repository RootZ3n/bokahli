import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Bearer-token authentication.
 *
 * Exactly one route is unauthenticated: GET /health/live. Everything else —
 * including the chat UI's own HTML and assets — requires the token. The token
 * may arrive three ways:
 *
 *   1. Authorization: Bearer <token>       (clients: ikbi, Hermes, Pehlichi, curl)
 *   2. Cookie: bokahli_token=<token>       (browser, after bootstrap)
 *   3. ?token=<token> on a GET             (browser bootstrap only; the handler
 *                                           sets the cookie and redirects so the
 *                                           token leaves the URL immediately)
 *
 * Every failure path returns 401 with no detail about why. Fail closed.
 */
export type AuthSource = 'header' | 'cookie' | 'query';

export interface AuthResult {
  readonly ok: boolean;
  readonly source: AuthSource | null;
}

export const AUTH_COOKIE = 'bokahli_token';

export function authenticate(req: IncomingMessage, expected: string, url: URL): AuthResult {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m?.[1] && constantTimeEquals(m[1].trim(), expected)) {
      return { ok: true, source: 'header' };
    }
    // A present-but-wrong Authorization header never falls through to cookies.
    return { ok: false, source: null };
  }

  const cookie = readCookie(req.headers['cookie'], AUTH_COOKIE);
  if (cookie && constantTimeEquals(cookie, expected)) {
    return { ok: true, source: 'cookie' };
  }

  const q = url.searchParams.get('token');
  if (q && req.method === 'GET' && constantTimeEquals(q, expected)) {
    return { ok: true, source: 'query' };
  }

  return { ok: false, source: null };
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so length is not a fast-path oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
