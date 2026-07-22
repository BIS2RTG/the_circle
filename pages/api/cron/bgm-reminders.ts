import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAuthorizedCron } from './reminders';
import { sendAppGraphMail } from '@/lib/graphAppMail';
import { sendEmail } from '@/lib/email';
import { brandedEmailShell } from '@/lib/emailShell';

/**
 * GET/POST /api/cron/bgm-reminders — automated board/committee meeting reminders
 * (BGM-01). Emails invited directors (who have an email on file) and creates an
 * in-app notification for the meeting organiser at the 7-day and 1-day
 * milestones. Idempotent per milestone via reminded_7d / reminded_1d flags.
 * Best-effort throughout — a delivery failure never aborts the run.
 *
 * Registered in vercel.json alongside the existing daily reminder crons.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date();
  const in8Days = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);

  // Candidate meetings: scheduled, in the future, within the next 8 days.
  const { data: meetings, error } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, time_zone, location, is_virtual, virtual_link, meeting_type, committee_id, created_by, reminded_7d, reminded_1d')
    .eq('status', 'scheduled')
    .gte('scheduled_start', now.toISOString())
    .lte('scheduled_start', in8Days.toISOString());

  if (error) return res.status(500).json({ error: error.message });

  let sent = 0;
  const results: any[] = [];

  for (const m of meetings || []) {
    const daysUntil = Math.ceil((new Date(m.scheduled_start).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    let milestone: '7d' | '1d' | null = null;
    if (daysUntil <= 1 && !m.reminded_1d) milestone = '1d';
    else if (daysUntil <= 7 && !m.reminded_7d) milestone = '7d';
    if (!milestone) continue;

    // Invited directors with emails.
    const { data: register } = await supabaseAdmin
      .from('meeting_attendance')
      .select('director:directors(full_name, email)')
      .eq('meeting_id', m.id);

    const recipients = (register || [])
      .map((r: any) => r.director)
      .filter((d: any) => d && d.email);

    const whenLabel = formatWhen(m.scheduled_start, m.time_zone);
    const whereLabel = m.is_virtual ? (m.virtual_link ? `Virtual — ${m.virtual_link}` : 'Virtual') : (m.location || 'To be confirmed');

    for (const d of recipients) {
      const html = brandedEmailShell({
        heading: `Reminder: ${m.title}`,
        bodyHtml: `
          <p style="margin:0 0 12px">Dear ${escapeHtml(d.full_name)},</p>
          <p style="margin:0 0 12px">This is a reminder of the upcoming ${m.meeting_type === 'committee' ? 'committee' : 'board'} meeting.</p>
          <p style="margin:0 0 6px"><strong>When:</strong> ${escapeHtml(whenLabel)} (in ${daysUntil} day${daysUntil === 1 ? '' : 's'})</p>
          <p style="margin:0 0 6px"><strong>Where:</strong> ${escapeHtml(whereLabel)}</p>
        `,
      });
      const ok = await sendDirectEmail(d.email, `Reminder: ${m.title}`, html);
      if (ok) sent += 1;
    }

    // Notify the organiser in-app.
    if (m.created_by) {
      await supabaseAdmin.from('notifications').insert({
        recipient_id: m.created_by,
        type: 'task',
        title: 'Upcoming board meeting',
        message: `"${m.title}" is in ${daysUntil} day${daysUntil === 1 ? '' : 's'}. ${recipients.length} director(s) reminded.`,
        metadata: { action_label: 'View meeting', action_url: `/legal/board/meetings/${m.id}` },
        is_read: false,
      }).then(() => {}, () => {});
    }

    // Flag the milestone so we don't re-send on the next cron run.
    const patch = milestone === '1d' ? { reminded_1d: true, reminded_7d: true } : { reminded_7d: true };
    await supabaseAdmin.from('board_meetings').update(patch).eq('id', m.id);

    results.push({ meeting: m.id, milestone, recipients: recipients.length });
  }

  return res.status(200).json({ ok: true, sent, meetings: results });
}

/** Try the service mailbox (Graph app), fall back to Resend. */
async function sendDirectEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const r = await sendAppGraphMail({ to, subject, html });
    if (r.success) return true;
  } catch { /* fall through */ }
  try {
    await sendEmail({ to, subject, html });
    return true;
  } catch {
    return false;
  }
}

function formatWhen(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone }).format(new Date(iso));
  } catch { return new Date(iso).toUTCString(); }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
