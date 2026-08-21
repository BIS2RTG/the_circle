import type { NextApiRequest, NextApiResponse } from 'next';
import { requireBgm } from '@/lib/bgmApi';
import { buildCommitteesList } from '@/lib/bgmSSR';

/**
 * GET /api/legal/bgm/committees
 * List committees for the caller's org, each with its members (name + chair).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireBgm(req, res, ['bgm.meetings.view', 'bgm.directors.view']);
  if (!ctx) return;

  const committees = await buildCommitteesList(ctx.organizationId);
  return res.status(200).json({ committees });
}
