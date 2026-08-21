import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * GET  /api/legal/bgm/directors  — list directors (with committees they sit on)
 * POST /api/legal/bgm/directors  — create a director profile
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.directors.view', 'bgm.meetings.view']);
    if (!ctx) return;

    const { data: directors, error } = await supabaseAdmin
      .from('directors')
      .select('id, full_name, salutation, email, phone, appointed_date, term_end_date, is_independent, status, notes')
      .eq('organization_id', ctx.organizationId)
      .order('full_name');

    if (error) return res.status(500).json({ error: error.message });

    const ids = (directors || []).map((d) => d.id);
    let memberships: any[] = [];
    if (ids.length > 0) {
      const { data } = await supabaseAdmin
        .from('committee_memberships')
        .select('director_id, is_chair, committee:committees(id, name, slug)')
        .in('director_id', ids);
      memberships = data || [];
    }
    const byDirector = new Map<string, any[]>();
    for (const m of memberships) {
      const list = byDirector.get(m.director_id) || [];
      list.push({ ...m.committee, is_chair: m.is_chair });
      byDirector.set(m.director_id, list);
    }

    const result = (directors || []).map((d) => ({
      ...d,
      committees: byDirector.get(d.id) || [],
    }));

    return res.status(200).json({ directors: result });
  }

  if (req.method === 'POST') {
    const ctx = await requireBgm(req, res, ['bgm.directors.manage']);
    if (!ctx) return;

    const b = req.body || {};
    if (!b.full_name || typeof b.full_name !== 'string') {
      return res.status(400).json({ error: 'full_name is required' });
    }
    const fullName = b.full_name.trim();

    // get_or_create: for staff/AD picks, reuse an existing board member instead
    // of erroring on a duplicate — matched first by email, then by name.
    if (b.get_or_create) {
      if (b.email) {
        const { data: byEmail } = await supabaseAdmin
          .from('directors').select('id').eq('organization_id', ctx.organizationId).ilike('email', b.email).maybeSingle();
        if (byEmail) return res.status(200).json({ id: byEmail.id, existing: true });
      }
      const { data: byName } = await supabaseAdmin
        .from('directors').select('id').eq('organization_id', ctx.organizationId).ilike('full_name', fullName).maybeSingle();
      if (byName) return res.status(200).json({ id: byName.id, existing: true });
    }

    const { data, error } = await supabaseAdmin
      .from('directors')
      .insert({
        organization_id: ctx.organizationId,
        full_name: fullName,
        salutation: b.salutation || null,
        email: b.email || null,
        phone: b.phone || null,
        appointed_date: b.appointed_date || null,
        term_end_date: b.term_end_date || null,
        is_independent: typeof b.is_independent === 'boolean' ? b.is_independent : null,
        is_hrims: b.is_hrims === true ? true : b.is_hrims === false ? false : null,
        notes: b.notes || null,
      })
      .select('id')
      .single();

    if (error) {
      if ((error as any).code === '23505') {
        // Duplicate name: reuse it for get_or_create, otherwise report the clash.
        if (b.get_or_create) {
          const { data: ex } = await supabaseAdmin
            .from('directors').select('id').eq('organization_id', ctx.organizationId).ilike('full_name', fullName).maybeSingle();
          if (ex) return res.status(200).json({ id: ex.id, existing: true });
        }
        return res.status(409).json({ error: 'A director with this name already exists.' });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json({ id: data.id });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
