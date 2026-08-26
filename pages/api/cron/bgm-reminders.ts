import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAuthorizedCron } from './reminders';
import { sendBoardEmail } from '@/lib/graphCalendar';
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
    .select('id, organization_id, title, scheduled_start, time_zone, location, is_virtual, virtual_link, meeting_type, committee_id, created_by, reminded_7d, reminded_1d')
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
      const ok = await sendBoardEmail(m.created_by, { to: d.email, subject: `Reminder: ${m.title}`, html });
      if (ok) sent += 1;
    }

    // Notify the organiser in-app. (organization_id is NOT NULL on notifications.)
    if (m.created_by) {
      await supabaseAdmin.from('notifications').insert({
        organization_id: m.organization_id,
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

  // ------------------------------------------------------------------
  // Post-meeting attendance sign-off chasers (BGM-02).
  // For meetings that have ALREADY taken place but aren't finalized, re-send
  // each unsigned board member their personal sign link and nudge the legal
  // organiser (email + in-app) with who is still outstanding. Capped at 5
  // rounds and at most once per ~day per meeting.
  // ------------------------------------------------------------------
  const base = process.env.NEXTAUTH_URL || '';
  const signoff: any[] = [];
  const { data: pastMeetings } = await supabaseAdmin
    .from('board_meetings')
    .select('id, organization_id, title, scheduled_start, scheduled_end, time_zone, created_by, finalized_at, status, signoff_reminder_count, signoff_reminder_last_at')
    .neq('status', 'cancelled')
    .is('finalized_at', null)
    .lte('scheduled_start', now.toISOString());

  for (const m of pastMeetings || []) {
    const endMs = m.scheduled_end ? new Date(m.scheduled_end).getTime() : new Date(m.scheduled_start).getTime() + 3 * 3600_000;
    if (endMs > now.getTime()) continue;                                   // not over yet
    if ((m.signoff_reminder_count || 0) >= 5) continue;                     // don't nag forever
    if (m.signoff_reminder_last_at && now.getTime() - new Date(m.signoff_reminder_last_at).getTime() < 20 * 3600_000) continue; // ~once a day

    const { data: register } = await supabaseAdmin
      .from('meeting_attendance')
      .select('id, checkin_token, check_in_signature, director:directors(full_name, email)')
      .eq('meeting_id', m.id);
    const unsigned = (register || []).filter((r: any) => !r.check_in_signature);
    if (unsigned.length === 0) continue;                                    // everyone signed

    const whenLabel = formatWhen(m.scheduled_start, m.time_zone);

    // 1. Re-send each unsigned board member (with an email) their sign link.
    let remindedMembers = 0;
    for (const r of unsigned as any[]) {
      const d = r.director;
      if (!d?.email) continue;
      let token = r.checkin_token;
      if (!token) {
        token = crypto.randomBytes(18).toString('base64url');
        await supabaseAdmin.from('meeting_attendance').update({ checkin_token: token }).eq('id', r.id);
      }
      const url = `${base}/board/attend/${token}`;
      const html = brandedEmailShell({
        heading: `Please sign: ${m.title}`,
        bodyHtml: `
          <p style="margin:0 0 12px">Dear ${escapeHtml(d.full_name)},</p>
          <p style="margin:0 0 12px">Our records show you haven't yet signed for your attendance at <strong>${escapeHtml(m.title)}</strong> (${escapeHtml(whenLabel)}). Please confirm using your personal link below — no login needed.</p>
        `,
        actionUrl: url,
        actionLabel: 'Sign for attendance',
      });
      const ok = await sendBoardEmail(m.created_by, { to: d.email, subject: `Reminder — sign for attendance: ${m.title}`, html });
      if (ok) remindedMembers += 1;
    }

    // 2. Nudge the legal organiser: in-app notification + email listing who's outstanding.
    if (m.created_by) {
      const names = (unsigned as any[]).map((r) => r.director?.full_name).filter(Boolean);
      const list = names.slice(0, 10).join(', ') + (names.length > 10 ? `, +${names.length - 10} more` : '');
      await supabaseAdmin.from('notifications').insert({
        organization_id: m.organization_id,
        recipient_id: m.created_by,
        type: 'task',
        title: 'Board members still to sign attendance',
        message: `${unsigned.length} member(s) haven't signed for "${m.title}": ${list}.`,
        metadata: { action_label: 'Open register', action_url: `/legal/board/meetings/${m.id}` },
        is_read: false,
      }).then(() => {}, () => {});

      const { data: organiser } = await supabaseAdmin
        .from('app_users').select('email').eq('id', m.created_by).maybeSingle();
      if (organiser?.email) {
        const html = brandedEmailShell({
          heading: `Attendance sign-off outstanding: ${m.title}`,
          bodyHtml: `
            <p style="margin:0 0 12px">${unsigned.length} board member(s) have not yet signed for their attendance at <strong>${escapeHtml(m.title)}</strong> (${escapeHtml(whenLabel)}):</p>
            <p style="margin:0 0 12px">${escapeHtml(list)}</p>
            <p style="margin:0 0 12px">Each has been re-sent their personal signing link. Open the register to review or finalize it.</p>
          `,
          actionUrl: `${base}/legal/board/meetings/${m.id}`,
          actionLabel: 'Open the register',
        });
        await sendBoardEmail(m.created_by, { to: organiser.email, subject: `Attendance sign-off outstanding: ${m.title}`, html });
      }
    }

    await supabaseAdmin.from('board_meetings')
      .update({ signoff_reminder_count: (m.signoff_reminder_count || 0) + 1, signoff_reminder_last_at: now.toISOString() })
      .eq('id', m.id);
    signoff.push({ meeting: m.id, unsigned: unsigned.length, remindedMembers });
  }

  return res.status(200).json({ ok: true, sent, meetings: results, signoff });
}

function formatWhen(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone }).format(new Date(iso));
  } catch { return new Date(iso).toUTCString(); }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
