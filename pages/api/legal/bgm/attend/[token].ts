import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * PUBLIC (token-gated, no login) PERSONAL self check-in. The unique per-attendee
 * token identifies exactly one person, so the page can greet them by name and
 * they only sign. Time-limited to the meeting window; registers once.
 *   GET  /api/legal/bgm/attend/[token]  → { name, meeting, already, open }
 *   POST /api/legal/bgm/attend/[token]  { signature }  → records present + signature
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'Missing token' });

  // Resolve the token to a director attendance row or a guest row.
  const { data: dir } = await supabaseAdmin
    .from('meeting_attendance')
    .select('id, meeting_id, status, director:directors(full_name, salutation)')
    .eq('checkin_token', token).maybeSingle();

  let kind: 'director' | 'guest' = 'director';
  let attendee: { meeting_id: string; status: string | null; name: string; rowId: string } | null = null;

  if (dir) {
    attendee = { meeting_id: (dir as any).meeting_id, status: (dir as any).status, name: (dir as any).director?.full_name || 'Director', rowId: (dir as any).id };
  } else {
    const { data: guest } = await supabaseAdmin
      .from('meeting_guests')
      .select('id, meeting_id, status, full_name')
      .eq('checkin_token', token).maybeSingle();
    if (guest) { kind = 'guest'; attendee = { meeting_id: (guest as any).meeting_id, status: (guest as any).status, name: (guest as any).full_name, rowId: (guest as any).id }; }
  }

  if (!attendee) return res.status(404).json({ error: 'This attendance link is not valid.' });

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, scheduled_end, status, finalized_at, is_virtual')
    .eq('id', attendee.meeting_id).single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });

  const start = new Date(meeting.scheduled_start).getTime();
  const end = meeting.scheduled_end ? new Date(meeting.scheduled_end).getTime() : start + 3 * 3600_000;
  const now = Date.now();
  const open = now >= start - 3 * 3600_000 && now <= end + 6 * 3600_000
    && meeting.status !== 'cancelled' && !meeting.finalized_at;
  const already = !!attendee.status;

  if (req.method === 'GET') {
    return res.status(200).json({
      name: attendee.name,
      meeting: { title: meeting.title, scheduled_start: meeting.scheduled_start, is_virtual: meeting.is_virtual },
      already,
      open,
    });
  }

  if (req.method === 'POST') {
    if (already) return res.status(409).json({ error: 'You have already registered for this meeting.' });
    if (!open) return res.status(409).json({ error: 'Check-in is not open for this meeting.' });
    const { signature } = req.body || {};
    if (typeof signature !== 'string' || !signature.startsWith('data:image')) {
      return res.status(400).json({ error: 'Please sign to confirm your attendance.' });
    }
    const nowIso = new Date().toISOString();
    if (kind === 'guest') {
      const { error } = await supabaseAdmin.from('meeting_guests')
        .update({ status: 'present', checked_in_at: nowIso, check_in_signature: signature })
        .eq('id', attendee.rowId);
      if (error) return res.status(500).json({ error: 'Could not record your check-in.' });
    } else {
      const { error } = await supabaseAdmin.from('meeting_attendance')
        .update({ status: 'present', checked_in_at: nowIso, check_in_method: 'self_token', check_in_signature: signature, recorded_at: nowIso })
        .eq('id', attendee.rowId);
      if (error) return res.status(500).json({ error: 'Could not record your check-in.' });
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
