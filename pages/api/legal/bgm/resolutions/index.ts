import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { notifyOwnerAssigned } from '@/lib/bgmResolutionsServer';

/**
 * GET  /api/legal/bgm/resolutions           — resolutions + their action items
 *   query: include_archived=1
 * POST /api/legal/bgm/resolutions           — record a resolution (+ optional tasks)
 *   body: { title, description?, reference?, category?, resolution_date?,
 *           meeting_id?, committee_id?, tasks?: [{ title, description?, owner_user_id?,
 *           owner_name?, due_date? }] }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.resolutions.view']);
    if (!ctx) return;
    const includeArchived = req.query.include_archived === '1';

    let rq = supabaseAdmin
      .from('board_resolutions')
      .select('*, meeting:board_meetings(id, title, scheduled_start), committee:committees(id, name)')
      .eq('organization_id', ctx.organizationId)
      .order('resolution_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (!includeArchived) rq = rq.eq('is_archived', false);

    const { data: resolutions, error } = await rq;
    if (error) return res.status(500).json({ error: error.message });

    const ids = (resolutions || []).map((r) => r.id);
    let tasks: any[] = [];
    if (ids.length > 0) {
      const { data } = await supabaseAdmin
        .from('resolution_tasks')
        .select('*, owner:app_users!owner_user_id(id, display_name, email)')
        .in('resolution_id', ids)
        .order('created_at', { ascending: true });
      tasks = data || [];
    }
    const byResolution = new Map<string, any[]>();
    for (const t of tasks) {
      const list = byResolution.get(t.resolution_id) || [];
      list.push(t);
      byResolution.set(t.resolution_id, list);
    }
    const out = (resolutions || []).map((r) => ({ ...r, tasks: byResolution.get(r.id) || [] }));
    return res.status(200).json({ resolutions: out });
  }

  if (req.method === 'POST') {
    const ctx = await requireBgm(req, res, ['bgm.resolutions.manage']);
    if (!ctx) return;
    const b = req.body || {};
    if (!b.title || typeof b.title !== 'string' || !b.title.trim()) {
      return res.status(400).json({ error: 'A resolution title is required.' });
    }

    const { data: resolution, error } = await supabaseAdmin
      .from('board_resolutions')
      .insert({
        organization_id: ctx.organizationId,
        meeting_id: b.meeting_id || null,
        committee_id: b.committee_id || null,
        reference: b.reference?.trim() || null,
        title: b.title.trim(),
        description: b.description?.trim() || null,
        category: b.category?.trim() || null,
        resolution_date: b.resolution_date || null,
        created_by: ctx.userId,
      })
      .select('id, title')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Optional initial action items.
    const tasks: any[] = Array.isArray(b.tasks) ? b.tasks : [];
    const inserts = tasks
      .filter((t) => t && typeof t.title === 'string' && t.title.trim())
      .map((t) => ({
        organization_id: ctx.organizationId,
        resolution_id: resolution.id,
        title: String(t.title).trim(),
        description: t.description?.trim() || null,
        owner_user_id: t.owner_user_id || null,
        owner_name: t.owner_name?.trim() || null,
        due_date: t.due_date || null,
        created_by: ctx.userId,
      }));

    if (inserts.length > 0) {
      const { data: createdTasks } = await supabaseAdmin.from('resolution_tasks').insert(inserts).select('id, title, owner_user_id, due_date');
      // Notify assigned owners.
      for (const t of createdTasks || []) {
        if (t.owner_user_id) {
          await notifyOwnerAssigned({
            ownerUserId: t.owner_user_id,
            taskTitle: t.title,
            resolutionTitle: resolution.title,
            resolutionId: resolution.id,
            dueDate: t.due_date,
            assignedByUserId: ctx.userId,
            assignedByName: ctx.displayName,
          });
        }
      }
    }

    return res.status(201).json({ id: resolution.id });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
