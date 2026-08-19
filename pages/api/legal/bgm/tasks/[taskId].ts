import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getUserRBACProfile, hasAnyPermission } from '@/lib/rbac';
import { TASK_STATUSES } from '@/lib/bgmResolutions';
import { notifyOwnerAssigned, notifyStatusChange } from '@/lib/bgmResolutionsServer';

/**
 * PATCH  /api/legal/bgm/tasks/[taskId]  — update an action item.
 *   Managers (bgm.resolutions.manage) may edit any field. The assigned owner may
 *   always update the status and progress note of their own task (even without a
 *   legal permission), as may anyone holding bgm.resolutions.update.
 * DELETE /api/legal/bgm/tasks/[taskId]  — managers only.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const taskId = String(req.query.taskId);

  const session = await getServerSession(req, res, authOptions);
  const userId = (session?.user as any)?.id;
  const orgId = (session?.user as any)?.org_id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { data: task } = await supabaseAdmin
    .from('resolution_tasks')
    .select('*, resolution:board_resolutions(id, title, created_by, organization_id)')
    .eq('id', taskId).maybeSingle();
  if (!task || (task as any).resolution?.organization_id !== orgId) {
    return res.status(404).json({ error: 'Action item not found.' });
  }

  const profile = await getUserRBACProfile(userId);
  const canManage = hasAnyPermission(profile, ['bgm.resolutions.manage']);
  const canUpdate = hasAnyPermission(profile, ['bgm.resolutions.update']);
  const isOwner = task.owner_user_id === userId;

  if (req.method === 'PATCH') {
    if (!canManage && !canUpdate && !isOwner) {
      return res.status(403).json({ error: 'You do not have permission to update this action.' });
    }

    const b = req.body || {};
    const patch: Record<string, any> = {};
    const resolution = (task as any).resolution;
    const actorName = session!.user?.name || null;

    // Fields only managers may change.
    if (canManage) {
      if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim();
      if ('description' in b) patch.description = b.description?.trim() || null;
      if ('owner_name' in b) patch.owner_name = b.owner_name?.trim() || null;
      if ('due_date' in b) {
        patch.due_date = b.due_date || null;
        // A new deadline resets the automated-reminder dedupe.
        patch.notified_due_soon = false;
        patch.notified_overdue = false;
      }
      if ('owner_user_id' in b) patch.owner_user_id = b.owner_user_id || null;
    }

    // Status + progress note: managers, holders of update, or the owner.
    let statusChanged = false;
    if ('status' in b) {
      if (!TASK_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status.' });
      if (b.status !== task.status) {
        statusChanged = true;
        patch.status = b.status;
        patch.resolved_at = b.status === 'resolved' ? new Date().toISOString() : null;
        if (b.status !== task.status) { patch.notified_overdue = false; patch.notified_due_soon = false; }
      }
    }
    if ('progress_note' in b) patch.progress_note = b.progress_note?.trim() || null;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    const { error } = await supabaseAdmin.from('resolution_tasks').update(patch).eq('id', taskId);
    if (error) return res.status(500).json({ error: error.message });

    // Append to the progress log when the status changed or a note was added.
    const noteText = typeof b.progress_note === 'string' ? b.progress_note.trim() : '';
    if (statusChanged || noteText) {
      await supabaseAdmin.from('resolution_task_updates').insert({
        organization_id: task.organization_id,
        task_id: taskId,
        status: statusChanged ? patch.status : null,
        note: noteText || null,
        created_by: userId,
        created_by_name: actorName,
      }).then(() => {}, () => {});
    }

    // Notify a newly-assigned owner.
    if (canManage && 'owner_user_id' in b && b.owner_user_id && b.owner_user_id !== task.owner_user_id) {
      await notifyOwnerAssigned({
        ownerUserId: b.owner_user_id,
        taskTitle: patch.title || task.title,
        resolutionTitle: resolution?.title || 'Resolution',
        resolutionId: resolution?.id,
        dueDate: 'due_date' in patch ? patch.due_date : task.due_date,
        assignedByUserId: userId,
        assignedByName: actorName,
      });
    }

    // Notify the resolution owner/creator when the assignee moves the status.
    if (statusChanged && !canManage) {
      await notifyStatusChange({
        recipientUserId: resolution?.created_by || null,
        actorName,
        taskTitle: task.title,
        resolutionTitle: resolution?.title || 'Resolution',
        resolutionId: resolution?.id,
        newStatus: patch.status,
        dueDate: task.due_date,
        note: noteText || null,
      });
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!canManage) return res.status(403).json({ error: 'You do not have permission to delete this action.' });
    const { error } = await supabaseAdmin.from('resolution_tasks').delete().eq('id', taskId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
