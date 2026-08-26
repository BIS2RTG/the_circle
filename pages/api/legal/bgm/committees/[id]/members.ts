import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * Committee-centric membership management (BGM committee compositions).
 *   GET                              — list this committee's members (+ chair)
 *   POST   { director_id, is_chair? }— add a member (chair is single per committee)
 *   PATCH  { director_id, is_chair } — set/clear the chair (clears others on set)
 *   DELETE ?director_id=             — remove a member
 * Writes accept bgm.committees.manage OR bgm.directors.manage so the legal team
 * (who hold directors.manage) can maintain compositions.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const committeeId = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.directors.view', 'bgm.meetings.view']);
    if (!ctx) return;
    const committee = await getCommittee(committeeId, ctx.organizationId);
    if (!committee) return res.status(404).json({ error: 'Committee not found' });
    return res.status(200).json({ members: await listMembers(committeeId) });
  }

  const ctx = await requireBgm(req, res, ['bgm.committees.manage', 'bgm.directors.manage']);
  if (!ctx) return;
  const committee = await getCommittee(committeeId, ctx.organizationId);
  if (!committee) return res.status(404).json({ error: 'Committee not found' });

  if (req.method === 'POST' || req.method === 'PATCH') {
    const directorId = req.body?.director_id;
    if (!directorId) return res.status(400).json({ error: 'director_id is required' });

    // Director must belong to the same org.
    const { data: director } = await supabaseAdmin
      .from('directors').select('id').eq('id', directorId).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!director) return res.status(404).json({ error: 'Director not found' });

    const makeChair = !!req.body?.is_chair;
    // A committee has a single chair — clear any existing chair when setting one.
    if (makeChair) {
      await supabaseAdmin.from('committee_memberships').update({ is_chair: false })
        .eq('committee_id', committeeId).neq('director_id', directorId);
    }
    const { error } = await supabaseAdmin
      .from('committee_memberships')
      .upsert({ committee_id: committeeId, director_id: directorId, is_chair: makeChair }, { onConflict: 'committee_id,director_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, members: await listMembers(committeeId) });
  }

  if (req.method === 'DELETE') {
    const directorId = req.query.director_id;
    if (!directorId) return res.status(400).json({ error: 'director_id is required' });
    const { error } = await supabaseAdmin
      .from('committee_memberships').delete().eq('committee_id', committeeId).eq('director_id', String(directorId));
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, members: await listMembers(committeeId) });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function getCommittee(id: string, orgId: string) {
  const { data } = await supabaseAdmin.from('committees').select('id').eq('id', id).eq('organization_id', orgId).maybeSingle();
  return data;
}

async function listMembers(committeeId: string) {
  const { data } = await supabaseAdmin
    .from('committee_memberships')
    .select('is_chair, director:directors(id, full_name, salutation, email, status)')
    .eq('committee_id', committeeId);
  return (data || [])
    .map((m: any) => ({ ...m.director, is_chair: m.is_chair }))
    .filter((m: any) => m.id)
    .sort((a: any, b: any) => (a.is_chair === b.is_chair ? a.full_name.localeCompare(b.full_name) : a.is_chair ? -1 : 1));
}
