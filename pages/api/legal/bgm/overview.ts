import type { NextApiRequest, NextApiResponse } from 'next';
import { requireBgm } from '@/lib/bgmApi';
import { buildBoardOverview } from '@/lib/bgmSSR';

/**
 * GET /api/legal/bgm/overview?year=
 * One authenticated call returning everything the Board Governance hub needs.
 * The heavy lifting lives in buildBoardOverview so the page can also SSR it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireBgm(req, res, ['bgm.meetings.view', 'bgm.directors.view', 'legal.access']);
  if (!ctx) return;
  const year = req.query.year ? parseInt(String(req.query.year), 10) : new Date().getFullYear();

  const data = await buildBoardOverview(ctx.organizationId, year);
  return res.status(200).json(data);
}
