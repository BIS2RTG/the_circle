import type { NextApiRequest, NextApiResponse } from 'next';
import { isAuthorizedCron } from './reminders';
import { dispatchDueInvitations } from '@/lib/bgmDispatch';

/**
 * GET/POST /api/cron/bgm-dispatch — send any scheduled board/committee meeting
 * invitations that are now due (invitations_scheduled_for <= now, not yet sent),
 * across ALL organisations. This is what makes the "schedule when invitations are
 * sent" option actually fire on production; the in-app /api/legal/bgm/dispatch
 * covers preview/staging (where Vercel crons don't run) when a legal user opens
 * the board area. Idempotent — a meeting is only sent once.
 *
 * Registered in vercel.json.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  const results = await dispatchDueInvitations();
  return res.status(200).json({ ok: true, dispatched: results.length, results });
}
