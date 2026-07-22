import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { sendAppGraphMail, isGraphAppMailConfigured } from '@/lib/graphAppMail';
import { sendEmail as sendResendEmail } from '@/lib/email';
import { brandedEmailShell } from '@/lib/emailShell';

/**
 * POST /api/legal/bgm/meetings/[id]/checkin-link
 * Email the meeting's QR self check-in link to specific addresses.
 * Body: { emails: string[] }. Ensures a check-in token exists first.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.attendance.manage']);
  if (!ctx) return;

  const emails: string[] = Array.isArray(req.body?.emails)
    ? req.body.emails.map((e: any) => String(e).trim()).filter((e: string) => /.+@.+\..+/.test(e))
    : [];
  if (emails.length === 0) return res.status(400).json({ error: 'Enter at least one valid email address.' });

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, time_zone, check_in_token')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  let token = meeting.check_in_token as string | null;
  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    await supabaseAdmin.from('board_meetings').update({ check_in_token: token }).eq('id', id);
  }

  const base = process.env.NEXTAUTH_URL || `https://${req.headers.host}`;
  const url = `${base}/board/checkin/${token}`;
  const when = (() => {
    try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: meeting.time_zone }).format(new Date(meeting.scheduled_start)); }
    catch { return new Date(meeting.scheduled_start).toUTCString(); }
  })();

  const html = brandedEmailShell({
    heading: `Check-in link: ${meeting.title}`,
    bodyHtml: `
      <p style="margin:0 0 12px">Use the link below to check in to <strong>${escapeHtml(meeting.title)}</strong> (${escapeHtml(when)}).</p>
      <p style="margin:0 0 16px">You'll confirm your attendance with your signature — no login needed.</p>
    `,
    actionUrl: url,
    actionLabel: 'Open check-in',
  });

  let sent = 0;
  const graphReady = isGraphAppMailConfigured();
  for (const to of emails) {
    let ok = false;
    if (graphReady) {
      try { const r = await sendAppGraphMail({ to, subject: `Check-in: ${meeting.title}`, html }); ok = r.success; } catch { /* noop */ }
    }
    if (!ok) { try { await sendResendEmail({ to, subject: `Check-in: ${meeting.title}`, html }); ok = true; } catch { /* noop */ } }
    if (ok) sent += 1;
  }

  if (sent === 0) return res.status(502).json({ error: 'No mail transport is configured, so the link could not be sent. Copy it instead.' });
  return res.status(200).json({ ok: true, sent, url });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
