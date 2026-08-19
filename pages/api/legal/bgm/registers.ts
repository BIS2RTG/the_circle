import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { REGISTER_ROW_KEY } from '@/lib/bgmDeclarations';

/**
 * GET /api/legal/bgm/registers?year=
 * Projects submitted Declaration-of-Interest and Related-Party declarations into
 * the two governance registers. Each register is a flat list of entries, one per
 * declared interest / related party, carrying the declaring director and the
 * declaration it came from. This is the auto-populated governance register.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireBgm(req, res, ['bgm.declarations.view']);
  if (!ctx) return;

  const year = req.query.year ? parseInt(String(req.query.year), 10) : null;

  let q = supabaseAdmin
    .from('governance_declarations')
    .select('id, declaration_type, period_year, submitted_at, form_data, director:directors(id, full_name)')
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'submitted')
    .in('declaration_type', ['declaration_of_interest', 'related_party'])
    .order('submitted_at', { ascending: false });
  if (year) q = q.eq('period_year', year);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const interests: any[] = [];
  const relatedParty: any[] = [];

  for (const d of data || []) {
    const dir = (d as any).director;
    const key = REGISTER_ROW_KEY[(d.declaration_type === 'related_party' ? 'related_party' : 'interests') as 'interests' | 'related_party'];
    const rows: any[] = Array.isArray((d.form_data as any)?.[key]) ? (d.form_data as any)[key] : [];
    const target = d.declaration_type === 'related_party' ? relatedParty : interests;
    if (rows.length === 0) {
      // Nil declaration — still record that the director declared nothing.
      target.push({
        director_id: dir?.id, director_name: dir?.full_name || 'Director',
        declaration_id: d.id, submitted_at: d.submitted_at, period_year: d.period_year,
        nil: true, fields: {},
      });
    } else {
      for (const r of rows) {
        target.push({
          director_id: dir?.id, director_name: dir?.full_name || 'Director',
          declaration_id: d.id, submitted_at: d.submitted_at, period_year: d.period_year,
          nil: false, fields: r,
        });
      }
    }
  }

  return res.status(200).json({ interests, related_party: relatedParty });
}
