import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * PUBLIC (token-gated, no login) self check-in behind a meeting QR code.
 *
 *   GET  /api/legal/bgm/checkin/[token]                 → meeting info + open state (NO attendee list)
 *   POST { action:'identify', email }                   → resolve the caller to THEIR own record only
 *   POST { action:'checkin', attendee_id, kind, mode, signature } → record attendance + signature
 *
 * Accuracy model: no roster is ever exposed, so a person cannot mark someone
 * else present by picking their name. Each attendee identifies themselves with
 * the email they were invited on and confirms with their own drawn signature
 * (the digital attendance-book signature). Recorded as check_in_method 'self_qr'.
 * (Per-director unique links — BGM-07 — would remove the email step entirely.)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, scheduled_end, status, finalized_at, is_virtual, virtual_platform')
    .eq('check_in_token', token)
    .single();
  if (!meeting) return res.status(404).json({ error: 'This check-in link is not valid.' });

  const start = new Date(meeting.scheduled_start).getTime();
  const end = meeting.scheduled_end ? new Date(meeting.scheduled_end).getTime() : start + 3 * 3600_000;
  const now = Date.now();
  const open = now >= start - 3 * 3600_000 && now <= end + 6 * 3600_000
    && meeting.status !== 'cancelled' && !meeting.finalized_at;

  if (req.method === 'GET') {
    return res.status(200).json({
      meeting: { title: meeting.title, scheduled_start: meeting.scheduled_start, is_virtual: meeting.is_virtual },
      open,
    });
  }

  if (req.method === 'POST') {
    const action = req.body?.action;

    // --- Identify: match the caller to their OWN invitee record by email ---
    if (action === 'identify') {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Enter the email address you were invited with.' });

      // Director invitee?
      const { data: dirRows } = await supabaseAdmin
        .from('meeting_attendance')
        .select('director_id, status, director:directors(full_name, email)')
        .eq('meeting_id', meeting.id);
      const dir = (dirRows || []).find((r: any) => (r.director?.email || '').toLowerCase() === email);
      if (dir) {
        return res.status(200).json({ attendee_id: (dir as any).director_id, kind: 'director', name: (dir as any).director?.full_name, already: !!(dir as any).status });
      }

      // Guest invitee?
      const { data: guest } = await supabaseAdmin
        .from('meeting_guests')
        .select('id, full_name, status, email')
        .eq('meeting_id', meeting.id)
        .ilike('email', email)
        .maybeSingle();
      if (guest) {
        return res.status(200).json({ attendee_id: guest.id, kind: 'guest', name: guest.full_name, already: !!guest.status });
      }

      return res.status(404).json({ error: 'That email isn’t on the invite list for this meeting. Please check with the secretary.' });
    }

    // --- Check in: record attendance + signature ---
    if (action === 'checkin') {
      if (!open) return res.status(409).json({ error: 'Check-in is not open for this meeting.' });
      const { attendee_id, kind, mode, signature } = req.body || {};
      if (!attendee_id || (mode !== 'present' && mode !== 'virtual')) {
        return res.status(400).json({ error: 'A valid attendee and attendance mode are required.' });
      }
      if (typeof signature !== 'string' || !signature.startsWith('data:image')) {
        return res.status(400).json({ error: 'Please sign to confirm your attendance.' });
      }
      const nowIso = new Date().toISOString();

      if (kind === 'guest') {
        const { error, count } = await supabaseAdmin
          .from('meeting_guests')
          .update({ status: mode, checked_in_at: nowIso, check_in_signature: signature }, { count: 'exact' })
          .eq('id', attendee_id).eq('meeting_id', meeting.id);
        if (error || !count) return res.status(500).json({ error: 'Could not record your check-in.' });
      } else {
        const { error, count } = await supabaseAdmin
          .from('meeting_attendance')
          .update({ status: mode, checked_in_at: nowIso, check_in_method: 'self_qr', recorded_at: nowIso, check_in_signature: signature }, { count: 'exact' })
          .eq('director_id', attendee_id).eq('meeting_id', meeting.id);
        if (error || !count) return res.status(500).json({ error: 'Could not record your check-in.' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
