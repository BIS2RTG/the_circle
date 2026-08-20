import type { NextApiRequest, NextApiResponse } from 'next';
import { isAuthorizedCron } from './reminders';
import { dispatchDueInvitations } from '@/lib/bgmDispatch';

/**
 * GET/POST /api/cron/bgm-dispatch — sends board/committee meeting invitations
 * whose scheduled send time has arrived (BGM-01 "schedule when invites go out").
 * Runs on the Vercel cron (production). Preview/staging rely on the in-app
 * opportunistic dispatch (/api/legal/bgm/dispatch) instead, since Vercel crons
 * don't run on non-production deployments.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  const dispatched = await dispatchDueInvitations();
  return res.status(200).json({ ok: true, dispatched });
}
