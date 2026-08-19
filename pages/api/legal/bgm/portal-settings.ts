import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { getDefaultTokenDays } from '@/lib/directorTokens';
import { MIN_TOKEN_DAYS, MAX_TOKEN_DAYS } from '@/lib/directorPortal';

/**
 * GET /api/legal/bgm/portal-settings — the org's configurable default link
 *     lifetime (director_token_days).
 * PUT /api/legal/bgm/portal-settings { days } — set it (clamped 1..90).
 * Stored in system_settings (category 'preferences').
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.portal.view', 'bgm.portal.manage']);
    if (!ctx) return;
    return res.status(200).json({ default_days: await getDefaultTokenDays(ctx.organizationId), min: MIN_TOKEN_DAYS, max: MAX_TOKEN_DAYS });
  }

  if (req.method === 'PUT') {
    const ctx = await requireBgm(req, res, ['bgm.portal.manage']);
    if (!ctx) return;
    const days = parseInt(String(req.body?.days), 10);
    if (!Number.isFinite(days) || days < MIN_TOKEN_DAYS || days > MAX_TOKEN_DAYS) {
      return res.status(400).json({ error: `Choose between ${MIN_TOKEN_DAYS} and ${MAX_TOKEN_DAYS} days.` });
    }
    const { error } = await supabaseAdmin
      .from('system_settings')
      .upsert(
        { organization_id: ctx.organizationId, category: 'preferences', key: 'director_token_days', value: days, updated_at: new Date().toISOString() },
        { onConflict: 'organization_id,category,key' },
      );
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, default_days: days });
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
