import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

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

  const { data: committees, error } = await supabaseAdmin
    .from('committees')
    .select('id, name, slug, description, is_main_board, is_active')
    .eq('organization_id', ctx.organizationId)
    .order('is_main_board', { ascending: false })
    .order('name');

  if (error) return res.status(500).json({ error: error.message });

  const committeeIds = (committees || []).map((c) => c.id);
  let memberships: any[] = [];
  if (committeeIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('committee_memberships')
      .select('committee_id, is_chair, director:directors(id, full_name, salutation, status)')
      .in('committee_id', committeeIds);
    memberships = data || [];
  }

  const byCommittee = new Map<string, any[]>();
  for (const m of memberships) {
    const list = byCommittee.get(m.committee_id) || [];
    list.push({ ...m.director, is_chair: m.is_chair });
    byCommittee.set(m.committee_id, list);
  }

  const result = (committees || []).map((c) => {
    const members = (byCommittee.get(c.id) || []).sort((a, b) =>
      a.is_chair === b.is_chair ? a.full_name.localeCompare(b.full_name) : a.is_chair ? -1 : 1
    );
    return { ...c, members, member_count: members.length };
  });

  return res.status(200).json({ committees: result });
}
