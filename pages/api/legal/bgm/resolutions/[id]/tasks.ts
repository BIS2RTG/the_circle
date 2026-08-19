import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { notifyOwnerAssigned } from '@/lib/bgmResolutionsServer';

/**
 * POST /api/legal/bgm/resolutions/[id]/tasks — add an action item to a resolution
 *   body: { title, description?, owner_user_id?, owner_name?, due_date? }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const resolutionId = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.resolutions.manage']);
  if (!ctx) return;

  const { data: resolution } = await supabaseAdmin
    .from('board_resolutions').select('id, title').eq('id', resolutionId).eq('organization_id', ctx.organizationId).maybeSingle();
  if (!resolution) return res.status(404).json({ error: 'Resolution not found.' });

  const b = req.body || {};
  if (!b.title || typeof b.title !== 'string' || !b.title.trim()) {
    return res.status(400).json({ error: 'An action title is required.' });
  }

  const { data: task, error } = await supabaseAdmin
    .from('resolution_tasks')
    .insert({
      organization_id: ctx.organizationId,
      resolution_id: resolutionId,
      title: b.title.trim(),
      description: b.description?.trim() || null,
      owner_user_id: b.owner_user_id || null,
      owner_name: b.owner_name?.trim() || null,
      due_date: b.due_date || null,
      created_by: ctx.userId,
    })
    .select('id, title, owner_user_id, due_date')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  if (task.owner_user_id) {
    await notifyOwnerAssigned({
      ownerUserId: task.owner_user_id,
      taskTitle: task.title,
      resolutionTitle: resolution.title,
      resolutionId,
      dueDate: task.due_date,
      assignedByUserId: ctx.userId,
      assignedByName: ctx.displayName,
    });
  }

  return res.status(201).json({ id: task.id });
}
