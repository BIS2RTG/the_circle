import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { issueDirectorLink, getDefaultTokenDays } from '@/lib/directorTokens';
import { recordAccessEvent } from '@/lib/directorAudit';
import { DIRECTOR_ACTIONS, DirectorAction } from '@/lib/directorPortal';
import { declarationLabel } from '@/lib/bgmDeclarations';

/**
 * BGM-07 admin issuance + audit for one director.
 *   GET    → active tokens, recent access events, issuable targets, default expiry
 *   POST   → issue a secure link { action, target_type?, target_id?, days? }
 *   DELETE → revoke a token ?token_id=  (audited)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const directorId = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.portal.view', 'bgm.portal.manage']);
    if (!ctx) return;

    const { data: director } = await supabaseAdmin
      .from('directors').select('id, full_name, email').eq('id', directorId).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!director) return res.status(404).json({ error: 'Director not found.' });

    const nowIso = new Date().toISOString();
    const [tokensRes, eventsRes, declRes, meetingRes] = await Promise.all([
      supabaseAdmin.from('director_action_tokens')
        .select('id, action, target_type, target_id, expires_at, used_count, max_uses, consumed_at, revoked_at, created_at')
        .eq('director_id', directorId).order('created_at', { ascending: false }).limit(25),
      supabaseAdmin.from('director_access_events')
        .select('id, event_type, action, detail, ip, created_at')
        .eq('director_id', directorId).order('created_at', { ascending: false }).limit(20),
      supabaseAdmin.from('governance_declarations')
        .select('id, declaration_type, period_year, due_date').eq('director_id', directorId).eq('status', 'issued'),
      supabaseAdmin.from('meeting_attendance')
        .select('status, meeting:board_meetings!inner(id, title, scheduled_start, status, finalized_at)')
        .eq('director_id', directorId).is('status', null),
    ]);

    const meetings = (meetingRes.data || [])
      .map((r: any) => r.meeting)
      .filter((m: any) => m && m.status !== 'cancelled' && !m.finalized_at && new Date(m.scheduled_start).getTime() >= Date.now() - 6 * 3600_000)
      .sort((a: any, b: any) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime());

    return res.status(200).json({
      director,
      hasEmail: !!director.email,
      default_days: await getDefaultTokenDays(ctx.organizationId),
      tokens: (tokensRes.data || []).map((t) => ({ ...t, expired: new Date(t.expires_at).getTime() < Date.now() })),
      events: eventsRes.data || [],
      targets: {
        declarations: (declRes.data || []).map((d) => ({ id: d.id, label: declarationLabel(d.declaration_type), period_year: d.period_year, due_date: d.due_date })),
        meetings: meetings.map((m: any) => ({ id: m.id, title: m.title, scheduled_start: m.scheduled_start })),
      },
      now: nowIso,
    });
  }

  if (req.method === 'POST') {
    const ctx = await requireBgm(req, res, ['bgm.portal.manage']);
    if (!ctx) return;

    const { data: director } = await supabaseAdmin
      .from('directors').select('id, full_name, salutation, email').eq('id', directorId).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!director) return res.status(404).json({ error: 'Director not found.' });

    const action = String(req.body?.action) as DirectorAction;
    if (!DIRECTOR_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown action.' });

    let targetType: 'meeting' | 'declaration' | null = null;
    let targetId: string | null = null;
    let contextHtml = '';

    if (action === 'confirm_attendance') {
      targetType = 'meeting'; targetId = req.body?.target_id || null;
      if (!targetId) return res.status(400).json({ error: 'Select a meeting.' });
      const { data: m } = await supabaseAdmin.from('board_meetings').select('title, scheduled_start, time_zone').eq('id', targetId).eq('organization_id', ctx.organizationId).maybeSingle();
      if (!m) return res.status(404).json({ error: 'Meeting not found.' });
      contextHtml = `<p style="margin:0 0 12px"><strong>${escapeHtml(m.title)}</strong><br/>${escapeHtml(fmtWhen(m.scheduled_start, m.time_zone))}</p>`;
    } else if (action === 'sign_declaration') {
      targetType = 'declaration'; targetId = req.body?.target_id || null;
      if (!targetId) return res.status(400).json({ error: 'Select a declaration.' });
      const { data: d } = await supabaseAdmin.from('governance_declarations').select('id, status').eq('id', targetId).eq('organization_id', ctx.organizationId).maybeSingle();
      if (!d) return res.status(404).json({ error: 'Declaration not found.' });
      if (d.status !== 'issued') return res.status(409).json({ error: 'That declaration is not awaiting completion.' });
    }

    const days = req.body?.days ? parseInt(String(req.body.days), 10) : null;
    const { minted, emailed, reason } = await issueDirectorLink({
      organizationId: ctx.organizationId,
      director,
      action,
      targetType,
      targetId,
      days,
      createdBy: ctx.userId,
      req,
      contextHtml,
    });

    if (!minted) return res.status(reason === 'no_email' ? 400 : 500).json({ error: reason === 'no_email' ? 'This director has no email address on file.' : 'Could not issue the link.' });
    return res.status(201).json({ url: minted.url, expiresAt: minted.expiresAt, emailed });
  }

  if (req.method === 'DELETE') {
    const ctx = await requireBgm(req, res, ['bgm.portal.manage']);
    if (!ctx) return;
    const tokenId = String(req.query.token_id || '');
    if (!tokenId) return res.status(400).json({ error: 'Missing token.' });
    const { data: tok } = await supabaseAdmin
      .from('director_action_tokens').select('id, action, consumed_at, revoked_at').eq('id', tokenId).eq('director_id', directorId).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!tok) return res.status(404).json({ error: 'Link not found.' });
    if (tok.consumed_at || tok.revoked_at) return res.status(409).json({ error: 'This link is already inactive.' });
    await supabaseAdmin.from('director_action_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', tokenId);
    await recordAccessEvent({ organizationId: ctx.organizationId, eventType: 'token_revoked', directorId, tokenId, action: tok.action, req });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

function fmtWhen(iso: string, tz?: string) {
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date(iso)); } catch { return new Date(iso).toUTCString(); }
}
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
