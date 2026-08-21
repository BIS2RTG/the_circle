import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { sendBoardEmail } from '@/lib/graphCalendar';
import { brandedEmailShell } from '@/lib/emailShell';
import { attendanceAcknowledgment } from '@/lib/bgmSSR';

/**
 * POST /api/legal/bgm/meetings/[id]/attendance-emails
 * Email a PERSONALISED sign link to selected attendees so they can sign for
 * attendance themselves. The legal team sets each member's attendance status
 * (present / apology / absent) here BEFORE sending — the member's signature then
 * acknowledges that recorded status (signing does not itself mean "present").
 * Body: { targets: [{ kind: 'director'|'guest', id, status: 'present'|'apology'|'absent' }] }
 */
const VALID_STATUS = new Set(['present', 'apology', 'absent']);

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
    .select('id, title, scheduled_start, time_zone, finalized_at, status, created_by')
    .eq('id', meetingId)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  if (meeting.status === 'cancelled') return res.status(409).json({ error: 'This meeting has been cancelled.' });
  if (meeting.finalized_at) return res.status(409).json({ error: 'This register is finalized and locked.' });

  const targets: { kind: 'director' | 'guest'; id: string; status: string }[] = Array.isArray(req.body?.targets) ? req.body.targets : [];
  if (targets.length === 0) return res.status(400).json({ error: 'Select at least one attendee.' });
  if (targets.some((t) => !t || (t.kind !== 'director' && t.kind !== 'guest') || !t.id || !VALID_STATUS.has(t.status))) {
    return res.status(400).json({ error: 'Each selected member needs an attendance status (present, apology or absent) before sending.' });
  }

  const dirIds = targets.filter((t) => t.kind === 'director').map((t) => t.id);
  const guestIds = targets.filter((t) => t.kind === 'guest').map((t) => t.id);
  const statusFor = new Map(targets.map((t) => [`${t.kind}:${t.id}`, t.status]));

  // Resolve the selected attendees (must belong to this meeting).
  type Row = { key: string; table: 'meeting_attendance' | 'meeting_guests'; match: Record<string, string>; name: string; email: string | null; token: string | null; status: string };
  const rows: Row[] = [];

  if (dirIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('meeting_attendance')
      .select('director_id, checkin_token, director:directors(full_name, salutation, email)')
      .eq('meeting_id', meetingId).in('director_id', dirIds);
    for (const r of data || []) {
      const key = `director:${(r as any).director_id}`;
      rows.push({ key, table: 'meeting_attendance', match: { meeting_id: meetingId, director_id: (r as any).director_id }, name: greetName((r as any).director), email: (r as any).director?.email || null, token: (r as any).checkin_token, status: statusFor.get(key) || 'present' });
    }
  }
  if (guestIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('meeting_guests')
      .select('id, checkin_token, full_name, email')
      .eq('meeting_id', meetingId).in('id', guestIds);
    for (const g of data || []) {
      const key = `guest:${(g as any).id}`;
      rows.push({ key, table: 'meeting_guests', match: { id: (g as any).id }, name: (g as any).full_name, email: (g as any).email, token: (g as any).checkin_token, status: statusFor.get(key) || 'present' });
    }
  }

  const base = process.env.NEXTAUTH_URL || `https://${req.headers.host}`;
  const when = (() => {
    try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: meeting.time_zone }).format(new Date(meeting.scheduled_start)); }
    catch { return new Date(meeting.scheduled_start).toUTCString(); }
  })();

  let sent = 0;
  let missing = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();

  for (const t of rows) {
    // Record the status the legal team set (so it's on the register regardless of
    // whether the member signs), and stamp when their link was last sent.
    const update: Record<string, any> = { status: t.status, checkin_link_sent_at: nowIso };
    if (!t.token) update.checkin_token = crypto.randomBytes(18).toString('base64url');
    await supabaseAdmin.from(t.table).update(update).match(t.match);
    const token = t.token || update.checkin_token;

    if (!t.email) { missing += 1; continue; }

    const url = `${base}/board/attend/${token}`;
    const ack = attendanceAcknowledgment(t.status, meeting.title);
    const html = brandedEmailShell({
      heading: `Please sign: ${meeting.title}`,
      bodyHtml: `
        <p style="margin:0 0 12px">Good day, ${escapeHtml(t.name)},</p>
        <p style="margin:0 0 12px">Please sign to confirm the attendance record for <strong>${escapeHtml(meeting.title)}</strong> (${escapeHtml(when)}).</p>
        <p style="margin:0 0 12px">By signing, you acknowledge <strong>${escapeHtml(ack)}</strong>. No login is needed — you'll simply confirm with your signature.</p>
      `,
      actionUrl: url,
      actionLabel: 'Sign for attendance',
    });
    if (await sendBoardEmail([ctx.userId, meeting.created_by], { to: t.email, subject: `Sign for attendance: ${meeting.title}`, html })) sent += 1;
    else failed += 1;
  }

  if (sent === 0 && missing === rows.length && rows.length > 0) {
    return res.status(400).json({ error: 'None of the selected attendees have an email address on file.', missing });
  }
  if (sent === 0 && failed > 0) {
    return res.status(502).json({
      error: 'Statuses were saved, but the emails could not be sent — email sending is not connected (sign in with Microsoft/Outlook to send).',
      sent, missing, failed,
    });
  }
  return res.status(200).json({ ok: true, sent, missing, failed });
}

function greetName(d: any): string {
  if (!d) return 'Director';
  return d.salutation ? `${d.salutation} ${stripSalutation(d.full_name, d.salutation)}` : d.full_name;
}
function stripSalutation(fullName: string, salutation: string): string {
  const fn = (fullName || '').trim();
  return fn.toLowerCase().startsWith(salutation.toLowerCase()) ? fn.slice(salutation.length).trim() : fn;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
