import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * POST /api/legal/bgm/meetings/[id]/checkin-token
 * Issue (or rotate) the opaque token behind the meeting's QR self check-in.
 * Body: { rotate?: boolean } — force a new token even if one exists.
 * Returns { token, url }.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.attendance.manage']);
  if (!ctx) return;

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, check_in_token')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  let token = meeting.check_in_token as string | null;
  if (!token || req.body?.rotate) {
    token = crypto.randomBytes(18).toString('base64url');
    const { error } = await supabaseAdmin
      .from('board_meetings')
      .update({ check_in_token: token })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
  }

  const base = process.env.NEXTAUTH_URL || `https://${req.headers.host}`;
  return res.status(200).json({ token, url: `${base}/board/checkin/${token}` });
}
