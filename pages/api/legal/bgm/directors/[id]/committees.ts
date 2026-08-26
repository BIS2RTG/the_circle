import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * Manage a director's committee memberships.
 *   POST   { committee_id, is_chair? }  — add / update a membership
 *   DELETE ?committee_id=               — remove from a committee
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const directorId = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.directors.manage']);
  if (!ctx) return;

  // Confirm the director belongs to the caller's org.
  const { data: director } = await supabaseAdmin
    .from('directors')
    .select('id')
    .eq('id', directorId)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!director) return res.status(404).json({ error: 'Director not found' });

  if (req.method === 'POST') {
    const committeeId = req.body?.committee_id;
    if (!committeeId) return res.status(400).json({ error: 'committee_id is required' });

    // Confirm committee is in this org.
    const { data: committee } = await supabaseAdmin
      .from('committees')
      .select('id')
      .eq('id', committeeId)
      .eq('organization_id', ctx.organizationId)
      .single();
    if (!committee) return res.status(404).json({ error: 'Committee not found' });

    const { error } = await supabaseAdmin
      .from('committee_memberships')
      .upsert(
        { committee_id: committeeId, director_id: directorId, is_chair: !!req.body?.is_chair },
        { onConflict: 'committee_id,director_id' }
      );
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const committeeId = req.query.committee_id;
    if (!committeeId) return res.status(400).json({ error: 'committee_id is required' });
    const { error } = await supabaseAdmin
      .from('committee_memberships')
      .delete()
      .eq('director_id', directorId)
      .eq('committee_id', String(committeeId));
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
