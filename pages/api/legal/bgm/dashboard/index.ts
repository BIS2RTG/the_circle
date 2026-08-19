import type { NextApiRequest, NextApiResponse } from 'next';
import { requireBgm } from '@/lib/bgmApi';
import { buildGovernanceDashboard } from '@/lib/bgmDashboard';

/**
 * GET /api/legal/bgm/dashboard?year= — the real-time governance dashboard data
 * (attendance, tenure, declarations, committees, milestones). BGM-08.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireBgm(req, res, ['bgm.reports.view']);
  if (!ctx) return;

  const year = req.query.year ? parseInt(String(req.query.year), 10) : new Date().getFullYear();
  try {
    const data = await buildGovernanceDashboard(ctx.organizationId, year);
    return res.status(200).json(data);
  } catch (e: any) {
    return res.status(500).json({ error: e.message || 'Failed to build dashboard.' });
  }
}
