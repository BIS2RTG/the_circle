import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { buildDirectorDetail } from '@/lib/bgmSSR';

/**
 * GET   /api/legal/bgm/directors/[id] — director profile, committees and
 *                                       cumulative attendance history (BGM-02).
 * PATCH /api/legal/bgm/directors/[id] — update director fields.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.directors.view', 'bgm.attendance.view']);
    if (!ctx) return;
    const detail = await buildDirectorDetail(ctx.organizationId, id);
    if (!detail) return res.status(404).json({ error: 'Director not found' });
    return res.status(200).json(detail);
  }

  if (req.method === 'PATCH') {
    const ctx = await requireBgm(req, res, ['bgm.directors.manage']);
    if (!ctx) return;

    const b = req.body || {};
    const patch: Record<string, any> = {};
    for (const f of ['full_name', 'salutation', 'email', 'phone', 'appointed_date', 'term_end_date', 'notes', 'status']) {
      if (f in b) patch[f] = b[f] === '' ? null : b[f];
    }
    if ('is_independent' in b) patch.is_independent = typeof b.is_independent === 'boolean' ? b.is_independent : null;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const { error } = await supabaseAdmin
      .from('directors')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', ctx.organizationId);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
