import type { NextApiRequest, NextApiResponse } from 'next';
import { destroyDirectorSession } from '@/lib/directorSession';

/** POST /api/portal/logout — end the current director portal session. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  await destroyDirectorSession(req, res);
  return res.status(200).json({ ok: true });
}
