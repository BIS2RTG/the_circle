import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAuthorizedCron } from './reminders';
import { distributeMeetingInvitation } from '@/lib/graphCalendar';

/**
 * GET/POST /api/cron/bgm-dispatch — sends board/committee meeting invitations
 * whose scheduled send time has arrived (BGM-01 "schedule when invites go out").
 *
 * Runs frequently (every ~15 min, see vercel.json) so a chosen send time is
 * honoured within minutes rather than waiting for a daily reminder pass. Only
 * touches meetings that are still 'scheduled' (not completed/cancelled) and not
 * already sent. Idempotent via invitations_sent_at.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date();
  const { data: due, error } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, scheduled_end, time_zone, location, is_virtual, virtual_platform, virtual_link, agenda, meeting_type, created_by')
    .eq('status', 'scheduled')
    .is('invitations_sent_at', null)
    .not('invitations_scheduled_for', 'is', null)
    .lte('invitations_scheduled_for', now.toISOString());

  if (error) return res.status(500).json({ error: error.message });

  const results: any[] = [];
  for (const m of due || []) {
    if (!m.created_by) continue;

    const { data: reg } = await supabaseAdmin
      .from('meeting_attendance')
      .select('director:directors(full_name, email)')
      .eq('meeting_id', m.id);
    const { data: guests } = await supabaseAdmin
      .from('meeting_guests')
      .select('full_name, email')
      .eq('meeting_id', m.id);

    const attendees = [
      ...(reg || []).map((r: any) => r.director).filter((d: any) => d?.email).map((d: any) => ({ email: d.email, name: d.full_name })),
      ...(guests || []).filter((g: any) => g.email).map((g: any) => ({ email: g.email, name: g.full_name })),
    ];
    if (attendees.length === 0) { results.push({ meeting: m.id, skipped: 'no_recipients' }); continue; }

    const teamsAuto = m.is_virtual && m.virtual_platform === 'teams' && !m.virtual_link;
    const end = m.scheduled_end || new Date(new Date(m.scheduled_start).getTime() + 2 * 60 * 60 * 1000).toISOString();
    const joinLine = m.is_virtual && m.virtual_link ? `<p><strong>Join:</strong> <a href="${escapeHtml(m.virtual_link)}">${escapeHtml(m.virtual_link)}</a></p>` : '';

    const outcome = await distributeMeetingInvitation({
      organiserUserId: m.created_by,
      uid: m.id,
      event: {
        subject: m.title,
        start: m.scheduled_start,
        end,
        timeZone: m.time_zone || 'Africa/Harare',
        location: m.is_virtual ? (m.virtual_link || 'Online') : m.location,
        isOnline: teamsAuto,
        onlineLink: m.virtual_link,
        bodyHtml: (m.agenda ? `<p>${escapeHtml(m.agenda)}</p>` : '') + joinLine,
        attendees,
      },
    });

    if (outcome.transport !== 'none') {
      await supabaseAdmin
        .from('board_meetings')
        .update({
          outlook_event_id: outcome.eventId ?? null,
          outlook_web_link: outcome.webLink ?? null,
          invitations_sent_at: now.toISOString(),
        })
        .eq('id', m.id);
    }
    results.push({ meeting: m.id, transport: outcome.transport, invited: attendees.length, error: outcome.error });
  }

  return res.status(200).json({ ok: true, dispatched: results });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
