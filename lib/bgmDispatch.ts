import { supabaseAdmin } from './supabaseAdmin';
import { distributeMeetingInvitation } from './graphCalendar';

/**
 * Send invitations for any meetings whose scheduled send time has arrived.
 * Shared by the Vercel cron (`/api/cron/bgm-dispatch`, global) and the in-app
 * opportunistic dispatch (`/api/legal/bgm/dispatch`, org-scoped) so scheduled
 * sends still fire on preview/staging where Vercel crons don't run.
 *
 * Idempotent via `invitations_sent_at`. Never throws.
 */
export async function dispatchDueInvitations(opts?: {
  organizationId?: string;
  /** Extra candidate sender ids (e.g. the active user) tried before the creator. */
  extraSenderIds?: (string | null)[];
}): Promise<Array<{ meeting: string; transport?: string; invited?: number; skipped?: string; error?: string }>> {
  const now = new Date();
  let query = supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, scheduled_end, time_zone, location, is_virtual, virtual_platform, virtual_link, agenda, meeting_type, created_by')
    .eq('status', 'scheduled')
    .is('invitations_sent_at', null)
    .not('invitations_scheduled_for', 'is', null)
    .lte('invitations_scheduled_for', now.toISOString());
  if (opts?.organizationId) query = query.eq('organization_id', opts.organizationId);

  const { data: due, error } = await query;
  if (error) return [{ meeting: 'query', error: error.message }];

  const results: Array<{ meeting: string; transport?: string; invited?: number; skipped?: string; error?: string }> = [];
  for (const m of due || []) {
    const { data: reg } = await supabaseAdmin
      .from('meeting_attendance').select('director:directors(full_name, email)').eq('meeting_id', m.id);
    const { data: guests } = await supabaseAdmin
      .from('meeting_guests').select('full_name, email').eq('meeting_id', m.id);

    const attendees = [
      ...(reg || []).map((r: any) => r.director).filter((d: any) => d?.email).map((d: any) => ({ email: d.email, name: d.full_name })),
      ...(guests || []).filter((g: any) => g.email).map((g: any) => ({ email: g.email, name: g.full_name })),
    ];
    if (attendees.length === 0) { results.push({ meeting: m.id, skipped: 'no_recipients' }); continue; }

    const teamsAuto = m.is_virtual && m.virtual_platform === 'teams' && !m.virtual_link;
    const end = m.scheduled_end || new Date(new Date(m.scheduled_start).getTime() + 2 * 60 * 60 * 1000).toISOString();
    const joinLine = m.is_virtual && m.virtual_link ? `<p><strong>Join:</strong> <a href="${escapeHtml(m.virtual_link)}">${escapeHtml(m.virtual_link)}</a></p>` : '';

    const outcome = await distributeMeetingInvitation({
      organiserUserId: [...(opts?.extraSenderIds || []), m.created_by],
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
      await supabaseAdmin.from('board_meetings').update({
        outlook_event_id: outcome.eventId ?? null,
        outlook_web_link: outcome.webLink ?? null,
        invitations_sent_at: now.toISOString(),
      }).eq('id', m.id);
    }
    results.push({ meeting: m.id, transport: outcome.transport, invited: attendees.length, error: outcome.error });
  }
  return results;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
