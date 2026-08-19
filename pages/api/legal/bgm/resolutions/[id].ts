import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * GET    /api/legal/bgm/resolutions/[id]  — resolution + tasks + per-task update log
 * PATCH  /api/legal/bgm/resolutions/[id]  — edit resolution fields / archive
 * DELETE /api/legal/bgm/resolutions/[id]  — delete resolution (cascades to tasks)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.resolutions.view']);
    if (!ctx) return;

    const { data: resolution, error } = await supabaseAdmin
      .from('board_resolutions')
      .select('*, meeting:board_meetings(id, title, scheduled_start), committee:committees(id, name), creator:app_users!created_by(id, display_name)')
      .eq('id', id).eq('organization_id', ctx.organizationId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!resolution) return res.status(404).json({ error: 'Resolution not found.' });

    const { data: tasks } = await supabaseAdmin
      .from('resolution_tasks')
      .select('*, owner:app_users!owner_user_id(id, display_name, email)')
      .eq('resolution_id', id)
      .order('created_at', { ascending: true });

    const taskIds = (tasks || []).map((t) => t.id);
    let updates: any[] = [];
    if (taskIds.length > 0) {
      const { data } = await supabaseAdmin
        .from('resolution_task_updates')
        .select('id, task_id, status, note, created_by_name, created_at')
        .in('task_id', taskIds)
        .order('created_at', { ascending: false });
      updates = data || [];
    }
    const updatesByTask = new Map<string, any[]>();
    for (const u of updates) {
      const list = updatesByTask.get(u.task_id) || [];
      list.push(u);
      updatesByTask.set(u.task_id, list);
    }
    const tasksOut = (tasks || []).map((t) => ({ ...t, updates: updatesByTask.get(t.id) || [] }));

    return res.status(200).json({ resolution, tasks: tasksOut, isOwner: false });
  }

  if (req.method === 'PATCH') {
    const ctx = await requireBgm(req, res, ['bgm.resolutions.manage']);
    if (!ctx) return;
    const { data: existing } = await supabaseAdmin
      .from('board_resolutions').select('id').eq('id', id).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Resolution not found.' });

    const b = req.body || {};
    const patch: Record<string, any> = {};
    if (typeof b.title === 'string') patch.title = b.title.trim();
    if ('description' in b) patch.description = b.description?.trim() || null;
    if ('reference' in b) patch.reference = b.reference?.trim() || null;
    if ('category' in b) patch.category = b.category?.trim() || null;
    if ('resolution_date' in b) patch.resolution_date = b.resolution_date || null;
    if ('meeting_id' in b) patch.meeting_id = b.meeting_id || null;
    if ('committee_id' in b) patch.committee_id = b.committee_id || null;
    if (typeof b.is_archived === 'boolean') patch.is_archived = b.is_archived;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    const { error } = await supabaseAdmin.from('board_resolutions').update(patch).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const ctx = await requireBgm(req, res, ['bgm.resolutions.manage']);
    if (!ctx) return;
    const { error } = await supabaseAdmin.from('board_resolutions').delete().eq('id', id).eq('organization_id', ctx.organizationId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
