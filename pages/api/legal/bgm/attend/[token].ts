import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildAttendView } from '@/lib/bgmSSR';

/**
 * PUBLIC (token-gated, no login) PERSONAL sign / self check-in.
 *
 * The unique per-attendee token identifies exactly one person, so the page greets
 * them by name and they only sign. Signing records their SIGNATURE against the
 * attendance row and confirms it. It does NOT by itself claim they were present —
 * the legal team sets each member's status (present / apology / absent) when
 * sending the link, and the member's signature acknowledges that recorded status.
 * Live self check-in (no status yet) still defaults to present.
 *
 *   GET  /api/legal/bgm/attend/[token]  → view payload (see buildAttendView)
 *   POST /api/legal/bgm/attend/[token]  { signature, agree_terms } → records signature
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'Missing token' });

  if (req.method === 'GET') {
    const view = await buildAttendView(token);
    if (!view.valid) return res.status(404).json({ error: view.error });
    const { valid, ...payload } = view;
    return res.status(200).json(payload);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- POST: record the signature ----
  const { data: dir } = await supabaseAdmin
    .from('meeting_attendance')
    .select('id, meeting_id, status, check_in_signature, director:directors(id, saved_signature, terms_accepted_at, is_hrims, email)')
    .eq('checkin_token', token).maybeSingle();

  let kind: 'director' | 'guest' = 'director';
  let director: any = null;
  let row: { meeting_id: string; status: string | null; rowId: string; signed: boolean } | null = null;

  if (dir) {
    director = (dir as any).director;
    row = { meeting_id: (dir as any).meeting_id, status: (dir as any).status, rowId: (dir as any).id, signed: !!(dir as any).check_in_signature };
  } else {
    const { data: guest } = await supabaseAdmin
      .from('meeting_guests')
      .select('id, meeting_id, status, check_in_signature')
      .eq('checkin_token', token).maybeSingle();
    if (guest) { kind = 'guest'; row = { meeting_id: (guest as any).meeting_id, status: (guest as any).status, rowId: (guest as any).id, signed: !!(guest as any).check_in_signature }; }
  }
  if (!row) return res.status(404).json({ error: 'This attendance link is not valid.' });

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('scheduled_start, status, finalized_at')
    .eq('id', row.meeting_id).maybeSingle();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });

  const start = new Date(meeting.scheduled_start).getTime();
  const open = Date.now() >= start - 3 * 3600_000 && meeting.status !== 'cancelled' && !meeting.finalized_at;

  // Terms are required for external (non-HRIMS) directors who haven't accepted yet.
  const isHrims = kind === 'director'
    ? (director?.is_hrims === true || director?.is_hrims === false
        ? director.is_hrims
        : !!(director?.email && (await supabaseAdmin.from('app_users').select('id').ilike('email', director.email).maybeSingle()).data))
    : true;
  const termsRequired = kind === 'director' && !isHrims && !director?.terms_accepted_at;

  if (row.signed) return res.status(409).json({ error: 'You have already signed for this meeting.' });
  if (!open) return res.status(409).json({ error: 'Signing is not open for this meeting.' });

  const { signature, agree_terms } = req.body || {};
  if (termsRequired && !agree_terms) return res.status(400).json({ error: 'Please accept the terms to continue.' });
  if (typeof signature !== 'string' || !signature.startsWith('data:image')) {
    return res.status(400).json({ error: 'Please sign to confirm.' });
  }

  const nowIso = new Date().toISOString();
  // Keep the status the legal team recorded; only default to present for a live
  // self check-in where no status has been set yet.
  const nextStatus = row.status || 'present';

  if (kind === 'guest') {
    const { error } = await supabaseAdmin.from('meeting_guests')
      .update({ status: nextStatus, checked_in_at: nowIso, check_in_signature: signature })
      .eq('id', row.rowId);
    if (error) return res.status(500).json({ error: 'Could not record your signature.' });
  } else {
    const { error } = await supabaseAdmin.from('meeting_attendance')
      .update({ status: nextStatus, checked_in_at: nowIso, check_in_method: 'self_token', check_in_signature: signature, confirmed_by_director: true, recorded_at: nowIso })
      .eq('id', row.rowId);
    if (error) return res.status(500).json({ error: 'Could not record your signature.' });

    // Persist terms acceptance + a reusable signature on the director profile.
    if (director?.id) {
      const patch: Record<string, any> = {};
      if (agree_terms && !director.terms_accepted_at) patch.terms_accepted_at = nowIso;
      if (!director.saved_signature) { patch.saved_signature = signature; patch.saved_signature_at = nowIso; }
      if (Object.keys(patch).length > 0) await supabaseAdmin.from('directors').update(patch).eq('id', director.id);
    }
  }

  return res.status(200).json({ ok: true });
}
