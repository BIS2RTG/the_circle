import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { sendBoardEmail } from '@/lib/graphCalendar';
import { brandedEmailShell } from '@/lib/emailShell';
import { DECLARATION_TYPES, getDeclarationDef } from '@/lib/bgmDeclarations';

/**
 * GET  /api/legal/bgm/declarations           — list declarations (filterable)
 *   query: type, status, director_id, year
 * POST /api/legal/bgm/declarations           — issue a declaration to a director
 *   body: { director_id, declaration_type, period_year?, due_date?, meeting_id?,
 *           send_email? (default true) }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.declarations.view']);
    if (!ctx) return;

    let q = supabaseAdmin
      .from('governance_declarations')
      .select('id, director_id, declaration_type, period_year, status, title, due_date, issued_at, submitted_at, signed_name, reminded_at, created_at, director:directors(id, full_name, salutation, email, status)')
      .eq('organization_id', ctx.organizationId)
      .order('created_at', { ascending: false });

    const { type, status, director_id, year } = req.query;
    if (type && DECLARATION_TYPES.includes(String(type) as any)) q = q.eq('declaration_type', String(type));
    if (status) q = q.eq('status', String(status));
    if (director_id) q = q.eq('director_id', String(director_id));
    if (year) q = q.eq('period_year', parseInt(String(year), 10));

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ declarations: data || [] });
  }

  if (req.method === 'POST') {
    const ctx = await requireBgm(req, res, ['bgm.declarations.manage']);
    if (!ctx) return;

    const b = req.body || {};
    const def = getDeclarationDef(String(b.declaration_type));
    if (!def) return res.status(400).json({ error: 'Unknown declaration type.' });
    if (!b.director_id) return res.status(400).json({ error: 'A director is required.' });

    // Director must belong to the caller's org.
    const { data: director } = await supabaseAdmin
      .from('directors')
      .select('id, full_name, salutation, email')
      .eq('id', b.director_id).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!director) return res.status(404).json({ error: 'Director not found.' });

    const token = crypto.randomBytes(20).toString('base64url');
    const nowIso = new Date().toISOString();
    // Login-free link valid for 60 days.
    const tokenExpires = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    const { data: created, error } = await supabaseAdmin
      .from('governance_declarations')
      .insert({
        organization_id: ctx.organizationId,
        director_id: director.id,
        declaration_type: def.type,
        period_year: def.isAnnual ? (b.period_year ? parseInt(String(b.period_year), 10) : new Date().getFullYear()) : (b.period_year ? parseInt(String(b.period_year), 10) : null),
        meeting_id: b.meeting_id || null,
        title: b.title || null,
        due_date: b.due_date || null,
        status: 'issued',
        access_token: token,
        token_expires_at: tokenExpires,
        issued_by: ctx.userId,
        issued_at: nowIso,
        created_by: ctx.userId,
      })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Email the login-free completion link (best-effort).
    let emailed = false;
    const sendEmail = b.send_email !== false;
    if (sendEmail && director.email) {
      const base = process.env.NEXTAUTH_URL || `https://${req.headers.host}`;
      const url = `${base}/board/declaration/${token}`;
      const greet = director.salutation ? `${director.salutation} ${director.full_name}` : director.full_name;
      const html = brandedEmailShell({
        heading: def.title,
        bodyHtml: `
          <p style="margin:0 0 12px">Dear ${escapeHtml(greet)},</p>
          <p style="margin:0 0 12px">As part of Rainbow Tourism Group's board governance, please complete and electronically sign your <strong>${escapeHtml(def.title)}</strong>.</p>
          <p style="margin:0 0 12px">${escapeHtml(def.instructions)}</p>
          ${b.due_date ? `<p style="margin:0 0 12px"><strong>Please complete by:</strong> ${escapeHtml(new Date(b.due_date).toLocaleDateString('en-GB', { dateStyle: 'long' } as any))}</p>` : ''}
          <p style="margin:0 0 12px">No login is required — the secure link below will take you straight to the form.</p>
        `,
        actionUrl: url,
        actionLabel: 'Complete & sign',
        preheader: `Please complete your ${def.shortLabel}.`,
      });
      emailed = await sendBoardEmail(ctx.userId, { to: director.email, subject: `Action required: ${def.title}`, html });
    }

    return res.status(201).json({ id: created.id, emailed });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
