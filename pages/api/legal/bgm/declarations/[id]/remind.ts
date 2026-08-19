import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { sendBoardEmail } from '@/lib/graphCalendar';
import { brandedEmailShell } from '@/lib/emailShell';
import { getDeclarationDef } from '@/lib/bgmDeclarations';

/**
 * POST /api/legal/bgm/declarations/[id]/remind
 * Re-send the login-free completion link to the director (regenerating the
 * token if it was spent or has expired). Only valid while the declaration is
 * still outstanding.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.declarations.manage']);
  if (!ctx) return;

  const { data: decl } = await supabaseAdmin
    .from('governance_declarations')
    .select('*, director:directors(full_name, salutation, email)')
    .eq('id', id).eq('organization_id', ctx.organizationId).maybeSingle();
  if (!decl) return res.status(404).json({ error: 'Declaration not found.' });
  if (decl.status === 'submitted') return res.status(409).json({ error: 'This declaration has already been submitted.' });
  if (decl.status === 'cancelled') return res.status(409).json({ error: 'This declaration has been cancelled.' });

  const director = (decl as any).director;
  if (!director?.email) return res.status(400).json({ error: 'This director has no email address on file.' });

  const def = getDeclarationDef(decl.declaration_type);

  // Ensure a live token.
  let token = decl.access_token as string | null;
  const expired = decl.token_expires_at && new Date(decl.token_expires_at).getTime() < Date.now();
  if (!token || expired) {
    token = crypto.randomBytes(20).toString('base64url');
    await supabaseAdmin.from('governance_declarations')
      .update({ access_token: token, token_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(), status: 'issued' })
      .eq('id', id);
  }

  const base = process.env.NEXTAUTH_URL || `https://${req.headers.host}`;
  const url = `${base}/board/declaration/${token}`;
  const greet = director.salutation ? `${director.salutation} ${director.full_name}` : director.full_name;
  const html = brandedEmailShell({
    heading: `Reminder: ${def?.title || 'Governance declaration'}`,
    bodyHtml: `
      <p style="margin:0 0 12px">Dear ${escapeHtml(greet)},</p>
      <p style="margin:0 0 12px">This is a reminder to complete and electronically sign your <strong>${escapeHtml(def?.title || 'governance declaration')}</strong>.</p>
      ${decl.due_date ? `<p style="margin:0 0 12px"><strong>Please complete by:</strong> ${escapeHtml(new Date(decl.due_date).toLocaleDateString('en-GB', { dateStyle: 'long' } as any))}</p>` : ''}
      <p style="margin:0 0 12px">No login is required — use the secure link below.</p>
    `,
    actionUrl: url,
    actionLabel: 'Complete & sign',
    preheader: `Reminder: complete your ${def?.shortLabel || 'declaration'}.`,
  });

  const ok = await sendBoardEmail(ctx.userId, { to: director.email, subject: `Reminder: ${def?.title || 'Governance declaration'}`, html });
  if (!ok) return res.status(502).json({ error: 'The reminder could not be sent. Please try again.' });

  await supabaseAdmin.from('governance_declarations').update({ reminded_at: new Date().toISOString() }).eq('id', id);
  return res.status(200).json({ ok: true });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
