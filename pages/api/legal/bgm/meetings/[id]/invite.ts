import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { distributeMeetingInvitation } from '@/lib/graphCalendar';

/**
 * POST /api/legal/bgm/meetings/[id]/invite
 * Distribute (or re-send) the Outlook meeting invitation to all invited
 * directors who have an email on file (BGM-01). Falls back to an .ics email
 * when delegated Graph access is unavailable.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.meetings.manage']);
  if (!ctx) return;

  const { data: meeting, error } = await supabaseAdmin
    .from('board_meetings')
    .select('*, committee:committees(name)')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .single();

  if (error || !meeting) return res.status(404).json({ error: 'Meeting not found' });
  if (meeting.status === 'cancelled') return res.status(400).json({ error: 'Meeting is cancelled' });
  if (meeting.status === 'completed' || new Date(meeting.scheduled_start).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'This meeting has already started or taken place — invitations can only be sent beforehand.' });
  }

  // Gather invitees (directors + guests) with emails. Disabled directors
  // (suspended / inactive / resigned / retired) are NEVER emailed an invitation.
  const { data: register } = await supabaseAdmin
    .from('meeting_attendance')
    .select('director:directors(full_name, email, status)')
    .eq('meeting_id', id);
  const { data: guests } = await supabaseAdmin
    .from('meeting_guests')
    .select('full_name, email')
    .eq('meeting_id', id);

  const activeRegister = (register || []).filter((r: any) => r.director && r.director.status === 'active');

  const attendees = [
    ...activeRegister.filter((r: any) => r.director.email).map((r: any) => ({ email: r.director.email as string, name: r.director.full_name as string })),
    ...(guests || []).filter((g: any) => g.email).map((g: any) => ({ email: g.email as string, name: g.full_name as string })),
  ];

  const missing = activeRegister.filter((r: any) => !r.director?.email).length
    + (guests || []).filter((g: any) => !g.email).length;

  if (attendees.length === 0) {
    return res.status(400).json({
      error: 'No invited directors have an email address on file. Add emails to director profiles first.',
      missing,
    });
  }

  const end = meeting.scheduled_end || new Date(new Date(meeting.scheduled_start).getTime() + 2 * 60 * 60 * 1000).toISOString();

  // Resolve the committee label — a meeting can span several committees.
  let committeeLabel: string | null = (meeting.committee as any)?.name || null;
  const committeeIds: string[] = Array.isArray((meeting as any).committee_ids) ? (meeting as any).committee_ids : [];
  if (committeeIds.length > 0) {
    const { data: cs } = await supabaseAdmin.from('committees').select('id, name').in('id', committeeIds);
    const names = committeeIds.map((cid) => (cs || []).find((c: any) => c.id === cid)?.name).filter(Boolean) as string[];
    if (names.length > 0) committeeLabel = names.join(' + ');
  }

  const platform = meeting.virtual_platform as string | null;
  const platformLabel = platform ? ({ zoom: 'Zoom', teams: 'Microsoft Teams', google_meet: 'Google Meet', other: 'Online' } as Record<string, string>)[platform] : 'Online';

  const outcome = await distributeMeetingInvitation({
    organiserUserId: [ctx.userId, meeting.created_by],
    organiserName: ctx.displayName,
    uid: meeting.id,
    event: {
      subject: meeting.title,
      start: meeting.scheduled_start,
      end,
      timeZone: meeting.time_zone || 'Africa/Harare',
      location: meeting.is_virtual ? (meeting.virtual_link || platformLabel) : meeting.location,
      isOnline: meeting.is_virtual,
      onlineLink: meeting.virtual_link,
      attendees,
      meetingId: meeting.id,
      organiserName: ctx.displayName,
      committeeLabel,
      platformLabel: meeting.is_virtual ? platformLabel : null,
      agenda: meeting.agenda || null,
    },
  });

  if (outcome.transport === 'none') {
    return res.status(502).json({
      error: 'Could not distribute invitations. Microsoft Outlook is not connected for your account.',
      detail: outcome.error,
    });
  }

  // Persist Outlook linkage + timestamp.
  await supabaseAdmin
    .from('board_meetings')
    .update({
      outlook_event_id: outcome.eventId ?? meeting.outlook_event_id ?? null,
      outlook_web_link: outcome.webLink ?? meeting.outlook_web_link ?? null,
      invitations_sent_at: new Date().toISOString(),
    })
    .eq('id', id);

  return res.status(200).json({
    ok: true,
    transport: outcome.transport,
    invited: attendees.length,
    missing_emails: missing,
  });
}
