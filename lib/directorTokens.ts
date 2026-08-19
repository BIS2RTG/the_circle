/**
 * BGM-07 — secure tokenised director links (server-only).
 *
 * Raw tokens are high-entropy and NEVER stored — only their SHA-256 hash is
 * persisted, so a database leak cannot reconstruct a working link. Links are
 * time-limited (org-configurable, default 7 days) and single-use by default.
 * Issuing, opening and consuming a token are all recorded in the immutable
 * audit trail (lib/directorAudit.ts).
 */
import crypto from 'crypto';
import type { NextApiRequest } from 'next';
import { supabaseAdmin } from './supabaseAdmin';
import { brandedEmailShell } from './emailShell';
import { sendBoardEmail } from './graphCalendar';
import { recordAccessEvent } from './directorAudit';
import {
  DEFAULT_TOKEN_DAYS, MIN_TOKEN_DAYS, MAX_TOKEN_DAYS,
  DirectorAction, DIRECTOR_ACTION_LABELS,
} from './directorPortal';

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function appBaseUrl(req?: NextApiRequest): string {
  const fromEnv = process.env.NEXTAUTH_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  if (req?.headers.host) return `https://${req.headers.host}`;
  return 'http://localhost:3000';
}

/** Resolve the org's configurable default link lifetime (days). */
export async function getDefaultTokenDays(organizationId: string): Promise<number> {
  try {
    const { data } = await supabaseAdmin
      .from('system_settings').select('value')
      .eq('organization_id', organizationId).eq('category', 'preferences').eq('key', 'director_token_days')
      .maybeSingle();
    const raw = (data as any)?.value;
    const num = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(num)) return DEFAULT_TOKEN_DAYS;
    return Math.min(MAX_TOKEN_DAYS, Math.max(MIN_TOKEN_DAYS, num));
  } catch {
    return DEFAULT_TOKEN_DAYS;
  }
}

export interface MintResult {
  raw: string;
  id: string;
  url: string;
  expiresAt: string;
}

/** Create a token row (hash stored) and record a token_issued audit event. */
export async function mintDirectorToken(params: {
  organizationId: string;
  directorId: string;
  action: DirectorAction;
  targetType?: 'meeting' | 'declaration' | null;
  targetId?: string | null;
  days?: number | null;
  maxUses?: number;
  createdBy?: string | null;
  req?: NextApiRequest;
}): Promise<MintResult | null> {
  const days = clampDays(params.days) ?? (await getDefaultTokenDays(params.organizationId));
  const raw = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('director_action_tokens')
    .insert({
      organization_id: params.organizationId,
      director_id: params.directorId,
      action: params.action,
      target_type: params.targetType ?? null,
      target_id: params.targetId ?? null,
      token_hash: hashToken(raw),
      expires_at: expiresAt,
      max_uses: params.maxUses ?? 1,
      created_by: params.createdBy ?? null,
    })
    .select('id')
    .single();

  if (error || !data) return null;

  await recordAccessEvent({
    organizationId: params.organizationId,
    eventType: 'token_issued',
    directorId: params.directorId,
    tokenId: data.id,
    action: params.action,
    req: params.req,
    metadata: { target_type: params.targetType ?? null, target_id: params.targetId ?? null, expires_at: expiresAt },
  });

  return { raw, id: data.id, url: `${appBaseUrl(params.req)}/board/link/${raw}`, expiresAt };
}

export type TokenStatus = 'valid' | 'expired' | 'consumed' | 'revoked' | 'invalid';

export interface ResolvedToken {
  status: TokenStatus;
  token?: any;
  director?: { id: string; full_name: string; salutation: string | null; email: string | null; status: string } | null;
}

/** Look a raw token up by hash and classify it. Does not consume it. */
export async function resolveDirectorToken(raw: string): Promise<ResolvedToken> {
  if (!raw) return { status: 'invalid' };
  const { data: token } = await supabaseAdmin
    .from('director_action_tokens')
    .select('*, director:directors(id, full_name, salutation, email, status)')
    .eq('token_hash', hashToken(raw))
    .maybeSingle();
  if (!token) return { status: 'invalid' };

  const director = (token as any).director || null;
  let status: TokenStatus = 'valid';
  if (token.revoked_at) status = 'revoked';
  else if (token.used_count >= token.max_uses || token.consumed_at) status = 'consumed';
  else if (new Date(token.expires_at).getTime() < Date.now()) status = 'expired';

  return { status, token, director };
}

/** Atomically mark one use of a token; sets consumed_at when fully spent. */
export async function consumeDirectorToken(token: any): Promise<boolean> {
  const nextCount = (token.used_count || 0) + 1;
  const patch: Record<string, any> = { used_count: nextCount };
  if (nextCount >= token.max_uses) patch.consumed_at = new Date().toISOString();
  // Guard against double-spend: only update while still unspent.
  const { data, error } = await supabaseAdmin
    .from('director_action_tokens')
    .update(patch)
    .eq('id', token.id)
    .lt('used_count', token.max_uses)
    .is('revoked_at', null)
    .select('id');
  return !error && !!data && data.length > 0;
}

function clampDays(days?: number | null): number | null {
  if (days === undefined || days === null || !Number.isFinite(days)) return null;
  return Math.min(MAX_TOKEN_DAYS, Math.max(MIN_TOKEN_DAYS, Math.round(days)));
}

// ---- Issue + email -----------------------------------------------------------

const ACTION_EMAIL_COPY: Record<DirectorAction, { subject: string; heading: string; intro: string; cta: string }> = {
  portal_login: {
    subject: 'Your Board Portal sign-in link',
    heading: 'Sign in to the Board Portal',
    intro: 'Use the secure link below to sign in to the Rainbow Tourism Group Board Portal, where you can view your meeting schedule, confirm attendance and complete governance declarations.',
    cta: 'Sign in to the portal',
  },
  confirm_attendance: {
    subject: 'Confirm your board meeting attendance',
    heading: 'Confirm your attendance',
    intro: 'Please use the secure link below to confirm your attendance at the upcoming meeting. No login is required.',
    cta: 'Confirm attendance',
  },
  sign_declaration: {
    subject: 'Complete your governance declaration',
    heading: 'Complete & sign your declaration',
    intro: 'Please use the secure link below to complete and electronically sign your governance declaration. No login is required.',
    cta: 'Complete & sign',
  },
  update_profile: {
    subject: 'Update your director profile',
    heading: 'Update your profile',
    intro: 'Please use the secure link below to review and update your director profile details. No login is required.',
    cta: 'Update my profile',
  },
};

/**
 * Mint a token and email the secure link to the director. Returns the mint
 * result plus whether the email was delivered. `days` overrides the org default.
 */
export async function issueDirectorLink(params: {
  organizationId: string;
  director: { id: string; full_name: string; salutation: string | null; email: string | null };
  action: DirectorAction;
  targetType?: 'meeting' | 'declaration' | null;
  targetId?: string | null;
  days?: number | null;
  createdBy?: string | null;
  req?: NextApiRequest;
  /** Extra sentence(s) injected into the email body (e.g. meeting title/date). */
  contextHtml?: string;
}): Promise<{ minted: MintResult | null; emailed: boolean; reason?: string }> {
  if (!params.director.email) return { minted: null, emailed: false, reason: 'no_email' };

  const minted = await mintDirectorToken({
    organizationId: params.organizationId,
    directorId: params.director.id,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    days: params.days,
    createdBy: params.createdBy,
    req: params.req,
  });
  if (!minted) return { minted: null, emailed: false, reason: 'mint_failed' };

  const copy = ACTION_EMAIL_COPY[params.action];
  const greet = params.director.salutation ? `${params.director.salutation} ${params.director.full_name}` : params.director.full_name;
  const expiryText = new Date(minted.expiresAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' } as any);
  const html = brandedEmailShell({
    heading: copy.heading,
    bodyHtml: `
      <p style="margin:0 0 12px">Dear ${escapeHtml(greet)},</p>
      <p style="margin:0 0 12px">${escapeHtml(copy.intro)}</p>
      ${params.contextHtml || ''}
      <p style="margin:0 0 12px;color:#8a7a5c;font-size:13px">This is a personal, single-use link. It expires on ${escapeHtml(expiryText)}. Please do not forward it.</p>
    `,
    actionUrl: minted.url,
    actionLabel: copy.cta,
    preheader: DIRECTOR_ACTION_LABELS[params.action],
  });

  const emailed = await sendBoardEmail([params.createdBy || null, null], { to: params.director.email, subject: copy.subject, html });
  return { minted, emailed, reason: emailed ? undefined : 'send_failed' };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
