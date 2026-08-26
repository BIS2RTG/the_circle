import type { NextApiRequest, NextApiResponse } from 'next';
import { requireBgm } from '@/lib/bgmApi';
import { dispatchDueInvitations } from '@/lib/bgmDispatch';

/**
 * POST /api/legal/bgm/dispatch — opportunistically send any scheduled meeting
 * invitations that are now due, for the caller's org. Called fire-and-forget
 * when a legal user opens the board area, so scheduled sends fire on
 * preview/staging where the Vercel cron doesn't run. Idempotent.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireBgm(req, res, ['bgm.meetings.manage']);
  if (!ctx) return;

  const dispatched = await dispatchDueInvitations({
    organizationId: ctx.organizationId,
    extraSenderIds: [ctx.userId],
  });
  return res.status(200).json({ ok: true, dispatched: dispatched.length, results: dispatched });
}
