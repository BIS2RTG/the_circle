import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveDirectorToken, consumeDirectorToken } from '@/lib/directorTokens';
import { recordAccessEvent } from '@/lib/directorAudit';
import { createDirectorSession } from '@/lib/directorSession';
import { getDeclarationDef } from '@/lib/bgmDeclarations';
import { applyDeclarationSubmission, isSignatureDataUrl } from '@/lib/bgmDeclarationsServer';

/**
 * PUBLIC (token-gated, no login) — BGM-07 secure single-action director link.
 *   GET  /api/board/link/[token]  → { status, action, director, meeting?/declaration?/profile? }
 *   POST /api/board/link/[token]  → consume the single-use token and perform the action
 *
 * Every access (open / complete / expired / invalid) is recorded in the
 * immutable director access audit trail.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = String(req.query.token || '');
  const resolved = await resolveDirectorToken(raw);

  // Attribute audit where we can (an entirely invalid token has no org context).
  const audit = (eventType: any, detail?: string) => {
    if (!resolved.token) return Promise.resolve();
    return recordAccessEvent({
      organizationId: resolved.token.organization_id,
      eventType, directorId: resolved.token.director_id, tokenId: resolved.token.id,
      action: resolved.token.action, detail, req,
    });
  };

  if (resolved.status !== 'valid') {
    if (resolved.status === 'expired') await audit('token_expired');
    else await audit('token_invalid', resolved.status);
    const msg = {
      expired: 'This link has expired. Please ask the Company Secretary to send a new one.',
      consumed: 'This link has already been used.',
      revoked: 'This link has been revoked.',
      invalid: 'This link is not valid.',
    }[resolved.status] || 'This link is not valid.';
    return res.status(410).json({ status: resolved.status, error: msg });
  }

  const token = resolved.token;
  const director = resolved.director;
  if (!director || director.status !== 'active') {
    await audit('denied', 'director_inactive');
    return res.status(403).json({ status: 'invalid', error: 'This link is no longer active.' });
  }

  // -------------------------------------------------- GET (render the action)
  if (req.method === 'GET') {
    await audit('token_opened');
    const base: any = {
      status: 'valid',
      action: token.action,
      director: { full_name: director.full_name, salutation: director.salutation },
      expires_at: token.expires_at,
    };

    if (token.action === 'confirm_attendance' && token.target_id) {
      const { data: meeting } = await supabaseAdmin
        .from('board_meetings').select('id, title, scheduled_start, scheduled_end, time_zone, is_virtual, location, virtual_link, status, finalized_at')
        .eq('id', token.target_id).maybeSingle();
      base.meeting = meeting || null;
      const { data: att } = await supabaseAdmin
        .from('meeting_attendance').select('status').eq('meeting_id', token.target_id).eq('director_id', director.id).maybeSingle();
      base.already = !!att?.status;
    } else if (token.action === 'sign_declaration' && token.target_id) {
      const { data: decl } = await supabaseAdmin
        .from('governance_declarations').select('id, declaration_type, status, period_year, due_date, form_data').eq('id', token.target_id).maybeSingle();
      base.declaration = decl ? { type: decl.declaration_type, period_year: decl.period_year, due_date: decl.due_date, form_data: decl.form_data || {} } : null;
      base.already = decl?.status === 'submitted';
    } else if (token.action === 'update_profile') {
      base.profile = { salutation: director.salutation, email: director.email, phone: (director as any).phone ?? null };
    }
    return res.status(200).json(base);
  }

  // -------------------------------------------------- POST (perform the action)
  if (req.method === 'POST') {
    const body = req.body || {};

    if (token.action === 'portal_login') {
      if (!(await consumeDirectorToken(token))) return res.status(409).json({ error: 'This link has already been used.' });
      const sessionId = await createDirectorSession(req, res, { organizationId: token.organization_id, directorId: director.id, tokenId: token.id });
      if (!sessionId) return res.status(500).json({ error: 'Could not start your session.' });
      await audit('token_completed');
      return res.status(200).json({ ok: true, redirect: '/board-portal' });
    }

    if (token.action === 'confirm_attendance') {
      if (!token.target_id) return res.status(400).json({ error: 'This link is missing its meeting.' });
      const { signature } = body;
      if (!isSignatureDataUrl(signature)) return res.status(400).json({ error: 'Please sign to confirm your attendance.' });

      const { data: meeting } = await supabaseAdmin
        .from('board_meetings').select('id, status, finalized_at').eq('id', token.target_id).maybeSingle();
      if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
      if (meeting.finalized_at) return res.status(409).json({ error: 'This attendance register is finalized.' });

      const { data: att } = await supabaseAdmin
        .from('meeting_attendance').select('id, status').eq('meeting_id', token.target_id).eq('director_id', director.id).maybeSingle();
      if (!att) return res.status(403).json({ error: 'You are not on the invitee list for this meeting.' });
      if (att.status) return res.status(409).json({ error: 'Your attendance is already recorded.' });

      if (!(await consumeDirectorToken(token))) return res.status(409).json({ error: 'This link has already been used.' });
      const nowIso = new Date().toISOString();
      await supabaseAdmin.from('meeting_attendance')
        .update({ status: 'present', checked_in_at: nowIso, check_in_method: 'self_token', check_in_signature: signature, recorded_at: nowIso, confirmed_by_director: true })
        .eq('id', att.id);
      await audit('attendance_confirmed');
      await audit('token_completed');
      return res.status(200).json({ ok: true });
    }

    if (token.action === 'sign_declaration') {
      if (!token.target_id) return res.status(400).json({ error: 'This link is missing its declaration.' });
      const { form_data, signature, signed_name, declaration_confirmed } = body;
      if (!declaration_confirmed) return res.status(400).json({ error: 'Please tick the declaration to confirm.' });
      if (!isSignatureDataUrl(signature)) return res.status(400).json({ error: 'Please sign to complete your declaration.' });

      const { data: decl } = await supabaseAdmin
        .from('governance_declarations').select('*').eq('id', token.target_id).maybeSingle();
      if (!decl || decl.director_id !== director.id) return res.status(404).json({ error: 'Declaration not found.' });
      if (decl.status === 'submitted') return res.status(409).json({ error: 'This declaration is already submitted.' });
      if (decl.status === 'cancelled') return res.status(410).json({ error: 'This declaration has been withdrawn.' });
      if (!getDeclarationDef(decl.declaration_type)) return res.status(400).json({ error: 'Unknown declaration type.' });

      if (!(await consumeDirectorToken(token))) return res.status(409).json({ error: 'This link has already been used.' });
      const result = await applyDeclarationSubmission({
        declaration: decl,
        formData: form_data && typeof form_data === 'object' ? form_data : {},
        signature,
        signedName: typeof signed_name === 'string' && signed_name.trim() ? signed_name.trim() : director.full_name,
        declarationConfirmed: true,
        via: 'self_link',
      });
      if (!result.ok) return res.status(500).json({ error: result.error });
      await audit('declaration_signed');
      await audit('token_completed');
      return res.status(200).json({ ok: true });
    }

    if (token.action === 'update_profile') {
      const patch: Record<string, any> = {};
      if (typeof body.salutation === 'string') patch.salutation = body.salutation.trim() || null;
      if (typeof body.email === 'string' && body.email.trim()) patch.email = body.email.trim();
      if (typeof body.phone === 'string') patch.phone = body.phone.trim() || null;
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

      if (!(await consumeDirectorToken(token))) return res.status(409).json({ error: 'This link has already been used.' });
      await supabaseAdmin.from('directors').update(patch).eq('id', director.id);
      await audit('profile_updated', Object.keys(patch).join(','));
      await audit('token_completed');
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unsupported action.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
