/**
 * Opportunistic background dispatcher for scheduled BGM meeting invitations.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { distributeMeetingInvitation } from './graphCalendar';

export interface DispatchDueInvitationsOptions {
  organizationId?: string;
  extraSenderIds?: string[];
}

export interface DispatchResult {
  meetingId: string;
  invited: number;
  transport?: string;
  error?: string;
}

/**
 * Find board meetings with pending invitations due for dispatch (invitations_scheduled_for <= NOW and invitations_sent_at is null)
 * and trigger invitation distribution via Graph / email.
 */
export async function dispatchDueInvitations(
  options: DispatchDueInvitationsOptions = {}
): Promise<DispatchResult[]> {
  const now = new Date().toISOString();

  let query = supabaseAdmin
    .from('board_meetings')
    .select('*, committee:committees(name)')
    .eq('status', 'scheduled')
    .is('invitations_sent_at', null)
    .not('invitations_scheduled_for', 'is', null)
    .lte('invitations_scheduled_for', now);

  if (options.organizationId) {
    query = query.eq('organization_id', options.organizationId);
  }

  const { data: meetings, error } = await query;
  if (error || !meetings || meetings.length === 0) {
    return [];
  }

  const results: DispatchResult[] = [];

  for (const m of meetings) {
    try {
      const { data: register } = await supabaseAdmin
        .from('meeting_attendance')
        .select('director:directors(full_name, email, status)')
        .eq('meeting_id', m.id);

      const { data: guests } = await supabaseAdmin
        .from('meeting_guests')
        .select('full_name, email')
        .eq('meeting_id', m.id);

      // Disabled directors are never emailed an invitation.
      const attendees = [
        ...(register || [])
          .map((r: any) => r.director)
          .filter((d: any) => d && d.email && d.status === 'active')
          .map((d: any) => ({ email: d.email as string, name: d.full_name as string })),
        ...(guests || [])
          .filter((g: any) => g.email)
          .map((g: any) => ({ email: g.email as string, name: g.full_name as string })),
      ];

      if (attendees.length === 0) {
        results.push({ meetingId: m.id, invited: 0, error: 'No attendees with email address' });
        continue;
      }

      const end = m.scheduled_end || new Date(new Date(m.scheduled_start).getTime() + 2 * 60 * 60 * 1000).toISOString();

      // Committee label — a meeting can span several committees.
      let committeeLabel: string | null = (m.committee as any)?.name || null;
      const committeeIds: string[] = Array.isArray((m as any).committee_ids) ? (m as any).committee_ids : [];
      if (committeeIds.length > 0) {
        const { data: cs } = await supabaseAdmin.from('committees').select('id, name').in('id', committeeIds);
        const names = committeeIds.map((cid) => (cs || []).find((c: any) => c.id === cid)?.name).filter(Boolean) as string[];
        if (names.length > 0) committeeLabel = names.join(' + ');
      }

      const platform = m.virtual_platform as string | null;
      const platformLabel = platform
        ? ({ zoom: 'Zoom', teams: 'Microsoft Teams', google_meet: 'Google Meet', other: 'Online' } as Record<string, string>)[platform]
        : 'Online';

      const outcome = await distributeMeetingInvitation({
        organiserUserId: options.extraSenderIds ? [...options.extraSenderIds, m.created_by] : [m.created_by],
        uid: m.id,
        event: {
          subject: m.title,
          start: m.scheduled_start,
          end,
          timeZone: m.time_zone || 'Africa/Harare',
          location: m.is_virtual ? (m.virtual_link || platformLabel) : m.location,
          isOnline: m.is_virtual,
          onlineLink: m.virtual_link,
          attendees,
          meetingId: m.id,
          committeeLabel,
          platformLabel: m.is_virtual ? platformLabel : null,
          agenda: m.agenda || null,
        },
      });

      if (outcome.transport !== 'none') {
        await supabaseAdmin
          .from('board_meetings')
          .update({
            outlook_event_id: outcome.eventId ?? m.outlook_event_id ?? null,
            outlook_web_link: outcome.webLink ?? m.outlook_web_link ?? null,
            invitations_sent_at: new Date().toISOString(),
          })
          .eq('id', m.id);
      }

      results.push({
        meetingId: m.id,
        invited: attendees.length,
        transport: outcome.transport,
        error: outcome.error,
      });
    } catch (err: any) {
      results.push({
        meetingId: m.id,
        invited: 0,
        error: err.message || 'Dispatch failed',
      });
    }
  }

  return results;
}
