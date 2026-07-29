import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { sendBoardEmail } from '@/lib/graphCalendar';
import { brandedEmailShell } from '@/lib/emailShell';

/**
 * POST /api/legal/bgm/meetings/[id]/attendance-emails
 * Email a PERSONALISED self check-in link to selected attendees so they can
 * sign for attendance themselves. Each link carries a unique per-attendee token
 * ("Good day, Mr X, sign for attendance here"), is time-limited to the meeting
 * window, and only registers once. Body:
 *   { director_ids?: string[], guest_ids?: string[] }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const meetingId = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.attendance.manage']);
  if (!ctx) return;

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, time_zone, finalized_at, status')
    .eq('id', meetingId)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  if (meeting.finalized_at) return res.status(409).json({ error: 'This register is finalized and locked.' });

  const directorIds: string[] = Array.isArray(req.body?.director_ids) ? req.body.director_ids : [];
  const guestIds: string[] = Array.isArray(req.body?.guest_ids) ? req.body.guest_ids : [];

  // Gather the selected attendees (must belong to this meeting).
  const targets: { table: 'meeting_attendance' | 'meeting_guests'; match: Record<string, string>; name: string; email: string | null; token: string | null }[] = [];

  if (directorIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('meeting_attendance')
      .select('director_id, checkin_token, director:directors(full_name, salutation, email)')
      .eq('meeting_id', meetingId).in('director_id', directorIds);
    for (const r of data || []) {
      targets.push({ table: 'meeting_attendance', match: { meeting_id: meetingId, director_id: (r as any).director_id }, name: greetName((r as any).director), email: (r as any).director?.email || null, token: (r as any).checkin_token });
    }
  }
  if (guestIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('meeting_guests')
      .select('id, checkin_token, full_name, email')
      .eq('meeting_id', meetingId).in('id', guestIds);
    for (const g of data || []) {
      targets.push({ table: 'meeting_guests', match: { id: (g as any).id }, name: (g as any).full_name, email: (g as any).email, token: (g as any).checkin_token });
    }
  }

  const base = process.env.NEXTAUTH_URL || `https://${req.headers.host}`;
  const when = (() => {
    try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: meeting.time_zone }).format(new Date(meeting.scheduled_start)); }
    catch { return new Date(meeting.scheduled_start).toUTCString(); }
  })();

  let sent = 0;
  let missing = 0;
  for (const t of targets) {
    if (!t.email) { missing += 1; continue; }
    // Ensure a unique token exists (reuse so earlier links keep working).
    let token = t.token;
    if (!token) {
      token = crypto.randomBytes(18).toString('base64url');
      await supabaseAdmin.from(t.table).update({ checkin_token: token }).match(t.match);
    }
    const url = `${base}/board/attend/${token}`;
    const html = brandedEmailShell({
      heading: `Attendance: ${meeting.title}`,
      bodyHtml: `
        <p style="margin:0 0 12px">Good day, ${escapeHtml(t.name)},</p>
        <p style="margin:0 0 12px">Please sign for your attendance at <strong>${escapeHtml(meeting.title)}</strong> (${escapeHtml(when)}) using your personal link below. You'll simply confirm with your signature — no login needed.</p>
      `,
      actionUrl: url,
      actionLabel: 'Sign for attendance',
    });
    if (await sendBoardEmail(ctx.userId, { to: t.email, subject: `Sign for attendance: ${meeting.title}`, html })) sent += 1;
  }

  if (sent === 0 && targets.length > 0 && missing === targets.length) {
    return res.status(400).json({ error: 'None of the selected attendees have an email address on file.' });
  }
  return res.status(200).json({ ok: true, sent, missing });
}

function greetName(d: any): string {
  if (!d) return 'Director';
  return d.salutation ? `${d.salutation} ${stripSalutation(d.full_name, d.salutation)}` : d.full_name;
}
// Avoid "Mr. Mr. Smith" if full_name already includes the salutation.
function stripSalutation(fullName: string, salutation: string): string {
  const fn = (fullName || '').trim();
  return fn.toLowerCase().startsWith(salutation.toLowerCase()) ? fn.slice(salutation.length).trim() : fn;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
