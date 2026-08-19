/**
 * BGM-07 — immutable director access audit trail writer (server-only).
 * Every portal / secure-link access event is recorded here. Writes are
 * best-effort (a failed audit insert never breaks the user's action) but the
 * table itself is append-only (a DB trigger blocks UPDATE/DELETE).
 */
import type { NextApiRequest } from 'next';
import { supabaseAdmin } from './supabaseAdmin';

export type AccessEventType =
  | 'token_issued' | 'token_opened' | 'token_completed' | 'token_expired'
  | 'token_invalid' | 'token_revoked' | 'login' | 'logout' | 'session_expired'
  | 'profile_updated' | 'attendance_confirmed' | 'declaration_signed'
  | 'viewed' | 'denied';

export function clientIp(req: NextApiRequest): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return fwd[0].split(',')[0].trim();
  return (req.socket && (req.socket as any).remoteAddress) || null;
}

export function userAgent(req: NextApiRequest): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 400) : null;
}

export async function recordAccessEvent(params: {
  organizationId: string;
  eventType: AccessEventType;
  directorId?: string | null;
  tokenId?: string | null;
  sessionId?: string | null;
  action?: string | null;
  detail?: string | null;
  req?: NextApiRequest;
  ip?: string | null;
  ua?: string | null;
  metadata?: Record<string, any>;
}): Promise<void> {
  try {
    await supabaseAdmin.from('director_access_events').insert({
      organization_id: params.organizationId,
      director_id: params.directorId ?? null,
      token_id: params.tokenId ?? null,
      session_id: params.sessionId ?? null,
      action: params.action ?? null,
      event_type: params.eventType,
      detail: params.detail ?? null,
      ip: params.ip ?? (params.req ? clientIp(params.req) : null),
      user_agent: params.ua ?? (params.req ? userAgent(params.req) : null),
      metadata: params.metadata ?? {},
    });
  } catch {
    /* best-effort */
  }
}
