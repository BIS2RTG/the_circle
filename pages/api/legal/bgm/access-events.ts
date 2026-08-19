import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * GET /api/legal/bgm/access-events — the immutable director access audit trail.
 *   query: director_id?, event_type?, limit? (default 100, max 500)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireBgm(req, res, ['bgm.portal.view', 'bgm.portal.manage']);
  if (!ctx) return;

  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
  let q = supabaseAdmin
    .from('director_access_events')
    .select('id, director_id, event_type, action, detail, ip, user_agent, created_at, director:directors(id, full_name)')
    .eq('organization_id', ctx.organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (req.query.director_id) q = q.eq('director_id', String(req.query.director_id));
  if (req.query.event_type) q = q.eq('event_type', String(req.query.event_type));

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ events: data || [] });
}
