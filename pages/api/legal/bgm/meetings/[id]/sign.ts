import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * POST /api/legal/bgm/meetings/[id]/sign
 * On-device attendance signature: the legal admin captures a board member's (or
 * guest's) signature on her device and it's recorded against that attendee —
 * marks them present, stamps an 'in_person' check-in and stores the signature.
 * Body: { kind: 'director'|'guest', id, signature }  (signature = data URL)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const meetingId = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.attendance.manage']);
  if (!ctx) return;

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, finalized_at')
    .eq('id', meetingId)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  if (meeting.finalized_at) return res.status(409).json({ error: 'This register is finalized and locked.' });

  const { kind, id, signature } = req.body || {};
  if (!id || (kind !== 'director' && kind !== 'guest')) {
    return res.status(400).json({ error: 'A valid attendee is required.' });
  }
  if (typeof signature !== 'string' || !signature.startsWith('data:image')) {
    return res.status(400).json({ error: 'A signature is required.' });
  }

  const now = new Date().toISOString();

  if (kind === 'guest') {
    const { error, count } = await supabaseAdmin
      .from('meeting_guests')
      .update({ status: 'present', checked_in_at: now, check_in_signature: signature, recorded_by: ctx.userId, recorded_at: now }, { count: 'exact' })
      .eq('id', id).eq('meeting_id', meetingId);
    if (error || !count) return res.status(500).json({ error: 'Could not record the signature.' });
  } else {
    const { error, count } = await supabaseAdmin
      .from('meeting_attendance')
      .update({ status: 'present', checked_in_at: now, check_in_method: 'in_person', check_in_signature: signature, recorded_by: ctx.userId, recorded_at: now }, { count: 'exact' })
      .eq('director_id', id).eq('meeting_id', meetingId);
    if (error || !count) return res.status(500).json({ error: 'Could not record the signature.' });
  }

  return res.status(200).json({ ok: true });
}
