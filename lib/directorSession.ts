/**
 * BGM-05 — Director Portal session (server-only).
 *
 * A passwordless, DB-backed, revocable session isolated from the app_users /
 * next-auth identity surface. The httpOnly cookie holds a random secret; only
 * its SHA-256 hash is stored, and the session row can be revoked or expired at
 * any time. Establishing and ending a session are recorded in the audit trail.
 */
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse, GetServerSidePropsContext } from 'next';
import { supabaseAdmin } from './supabaseAdmin';
import { recordAccessEvent, clientIp, userAgent } from './directorAudit';
import { PORTAL_SESSION_HOURS } from './directorPortal';

export const PORTAL_COOKIE = 'director_portal_session';

export interface DirectorSessionContext {
  sessionId: string;
  directorId: string;
  organizationId: string;
  director: { id: string; full_name: string; salutation: string | null; email: string | null; status: string };
}

function hash(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function readCookie(reqHeaders: string | undefined): string | null {
  if (!reqHeaders) return null;
  for (const c of reqHeaders.split(';').map((x) => x.trim())) {
    if (c.startsWith(`${PORTAL_COOKIE}=`)) return decodeURIComponent(c.slice(PORTAL_COOKIE.length + 1));
  }
  return null;
}

function setCookie(res: NextApiResponse, value: string, maxAgeSeconds: number) {
  const parts = [
    `${PORTAL_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const cookie = parts.join('; ');
  if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
  else if (typeof existing === 'string' && existing) res.setHeader('Set-Cookie', [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

/** Create a portal session for a director and set the cookie. Audits 'login'. */
export async function createDirectorSession(
  req: NextApiRequest, res: NextApiResponse,
  params: { organizationId: string; directorId: string; tokenId?: string | null }
): Promise<string | null> {
  const secret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('director_portal_sessions')
    .insert({
      organization_id: params.organizationId,
      director_id: params.directorId,
      session_hash: hash(secret),
      expires_at: expiresAt,
      ip: clientIp(req),
      user_agent: userAgent(req),
    })
    .select('id')
    .single();
  if (error || !data) return null;

  setCookie(res, secret, PORTAL_SESSION_HOURS * 3600);
  await recordAccessEvent({
    organizationId: params.organizationId, eventType: 'login',
    directorId: params.directorId, sessionId: data.id, tokenId: params.tokenId ?? null,
    action: 'portal_login', req,
  });
  return data.id;
}

async function resolveSession(secret: string | null): Promise<DirectorSessionContext | null> {
  if (!secret) return null;
  const { data: session } = await supabaseAdmin
    .from('director_portal_sessions')
    .select('*, director:directors(id, full_name, salutation, email, status)')
    .eq('session_hash', hash(secret))
    .maybeSingle();
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const director = (session as any).director;
  if (!director || director.status !== 'active') return null;

  // Touch last_seen_at (best-effort).
  supabaseAdmin.from('director_portal_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', session.id).then(() => {}, () => {});

  return {
    sessionId: session.id,
    directorId: session.director_id,
    organizationId: session.organization_id,
    director,
  };
}

/** API-route guard: returns the session context or writes 401 and returns null. */
export async function requireDirectorSession(req: NextApiRequest, res: NextApiResponse): Promise<DirectorSessionContext | null> {
  const ctx = await resolveSession(readCookie(req.headers.cookie));
  if (!ctx) { res.status(401).json({ error: 'Your portal session has ended. Please sign in again.' }); return null; }
  return ctx;
}

/** SSR helper for getServerSideProps: returns the session context or null. */
export async function getDirectorSessionSSR(ctx: GetServerSidePropsContext): Promise<DirectorSessionContext | null> {
  return resolveSession(readCookie(ctx.req.headers.cookie));
}

/** Revoke the current session, clear the cookie and audit 'logout'. */
export async function destroyDirectorSession(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const secret = readCookie(req.headers.cookie);
  if (secret) {
    const { data: session } = await supabaseAdmin
      .from('director_portal_sessions').select('id, organization_id, director_id').eq('session_hash', hash(secret)).maybeSingle();
    if (session) {
      await supabaseAdmin.from('director_portal_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', session.id);
      await recordAccessEvent({
        organizationId: session.organization_id, eventType: 'logout',
        directorId: session.director_id, sessionId: session.id, action: 'portal_login', req,
      });
    }
  }
  setCookie(res, '', 0);
}
