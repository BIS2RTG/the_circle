import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * GET /api/legal/bgm/meetings/[id]/calendar.ics
 *
 * Public, unauthenticated calendar file for a board/committee meeting so that
 * ANY invitee — including external guests on gmail / yahoo / icloud who have no
 * Circle login — can add the meeting to their calendar straight from the
 * invitation email. It only exposes the same details already in that email
 * (title, time, location, agenda), keyed by the opaque meeting UUID.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id || '');
  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, scheduled_end, time_zone, location, is_virtual, virtual_link, virtual_platform, agenda, status, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (!meeting) return res.status(404).send('Meeting not found');

  const start = new Date(meeting.scheduled_start);
  const end = meeting.scheduled_end
    ? new Date(meeting.scheduled_end)
    : new Date(start.getTime() + 2 * 60 * 60 * 1000);

  const platformLabel = meeting.virtual_platform
    ? ({ zoom: 'Zoom', teams: 'Microsoft Teams', google_meet: 'Google Meet', other: 'Online' } as Record<string, string>)[meeting.virtual_platform] || 'Online'
    : 'Online';
  const locationText = meeting.is_virtual
    ? (meeting.virtual_link || platformLabel)
    : (meeting.location || '');

  const descParts: string[] = [];
  if (meeting.agenda) descParts.push(`Agenda: ${meeting.agenda}`);
  if (meeting.is_virtual && meeting.virtual_link) descParts.push(`Join: ${meeting.virtual_link}`);

  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // Escape per RFC 5545 (backslash, semicolon, comma, newline).
  const esc = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

  const cancelled = meeting.status === 'cancelled';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rainbow Tourism Group//The Circle//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:bgm-${meeting.id}@thecircle.rtg.co.zw`,
    `DTSTAMP:${stamp(new Date(meeting.updated_at || Date.now()))}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(meeting.title)}`,
    locationText ? `LOCATION:${esc(locationText)}` : '',
    descParts.length ? `DESCRIPTION:${esc(descParts.join('\n'))}` : '',
    cancelled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  // CRLF line endings per the iCalendar spec.
  const ics = lines.join('\r\n') + '\r\n';

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="meeting-${meeting.id}.ics"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(ics);
}
