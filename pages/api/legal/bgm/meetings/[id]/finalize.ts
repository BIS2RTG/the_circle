import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { defaultQuorum } from '@/lib/bgm';

/**
 * POST /api/legal/bgm/meetings/[id]/finalize
 * Body: { signature }
 * Finalize locks the attendance register into an immutable record for the
 * minute book and marks the meeting completed. This is PERMANENT — a finalized
 * register can no longer be re-opened or edited. Returns quorum status.
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
    .select('id, status, quorum, finalized_at')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  // Finalizing is permanent — a finalized register can never be re-opened.
  if (!finalize) {
    return res.status(409).json({ error: 'A finalized register cannot be re-opened. Finalizing is permanent.' });
  }
  if (meeting.finalized_at) {
    return res.status(409).json({ error: 'This register is already finalized.' });
  }

  // The finaliser signs off; their signature (saved or freshly drawn — the
  // client resolves either to a self-contained image) appears at the bottom of
  // the report.
  const signature = req.body?.signatureData ?? req.body?.signature; // signature = legacy field
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
