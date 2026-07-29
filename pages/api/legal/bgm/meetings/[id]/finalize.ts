import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { defaultQuorum } from '@/lib/bgm';

/**
 * POST /api/legal/bgm/meetings/[id]/finalize
 * Body: { finalize: boolean }
 * Finalize locks the attendance register into an immutable record for the
 * minute book and marks the meeting completed; re-opening clears the lock.
 * Returns quorum status (attended vs required).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.attendance.manage']);
  if (!ctx) return;

  const finalize = req.body?.finalize !== false; // default true

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, status, quorum')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  if (!finalize) {
    const { error } = await supabaseAdmin
      .from('board_meetings')
      .update({ finalized_at: null, finalized_by: null, finalized_signature: null })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, finalized: false });
  }

  // The finaliser signs off; their signature appears at the bottom of the report.
  const signature = req.body?.signature;
  if (typeof signature !== 'string' || !signature.startsWith('data:image')) {
    return res.status(400).json({ error: 'A signature is required to finalize the register.' });
  }

  // Compute quorum from the register.
  const { data: rows } = await supabaseAdmin
    .from('meeting_attendance')
    .select('status')
    .eq('meeting_id', id);
  const invited = (rows || []).length;
  const attended = (rows || []).filter((r) => r.status === 'present' || r.status === 'virtual').length;
  const required = meeting.quorum ?? defaultQuorum(invited);

  const { error } = await supabaseAdmin
    .from('board_meetings')
    .update({ finalized_at: new Date().toISOString(), finalized_by: ctx.userId, finalized_signature: signature, status: 'completed' })
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    ok: true,
    finalized: true,
    quorum: { invited, attended, required, met: attended >= required },
  });
}
