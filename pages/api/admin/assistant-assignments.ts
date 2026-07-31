import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getUserRBACProfile, hasAnyPermission, PERMISSIONS } from '@/lib/rbac';
import { audit } from '@/lib/auditLog';

/**
 * Admin management of assistant assignments (who may file on whose behalf).
 *
 *   GET    [?assistantId=] — list assignments (optionally for one assistant),
 *                            joined to assistant + principal names.
 *   POST   { assistantId, principalId } — assign.
 *   DELETE ?id= | ?assistantId=&principalId= — unassign.
 *
 * Gated to systems admins / super users (admin.roles or users.assign_roles).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = session.user as any;
  const organizationId = user.org_id;
  if (!organizationId) return res.status(400).json({ error: 'No organization found' });

  const profile = await getUserRBACProfile(user.id);
  if (!hasAnyPermission(profile, [PERMISSIONS.ADMIN_ROLES, PERMISSIONS.USERS_ASSIGN_ROLES])) {
    return res.status(403).json({ error: 'You do not have permission to manage assistants' });
  }

  // ---- GET: list -----------------------------------------------------------
  if (req.method === 'GET') {
    let query = supabaseAdmin
      .from('assistant_assignments')
      .select(`
        id, created_at, assistant_id, principal_id,
        can_file, can_upload, can_edit, can_withdraw, can_manage_notifications, can_gatekeep,
        assistant:app_users!assistant_assignments_assistant_id_fkey ( id, display_name, email, job_title ),
        principal:app_users!assistant_assignments_principal_id_fkey ( id, display_name, email, job_title )
      `)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    const assistantId = req.query.assistantId as string | undefined;
    if (assistantId) query = query.eq('assistant_id', assistantId);

    const { data, error } = await query;
    if (error) {
      console.error('assistant-assignments list failed:', error);
      return res.status(500).json({ error: 'Failed to load assignments' });
    }
    return res.status(200).json({ assignments: data || [] });
  }

  // ---- POST: upsert the full capability set (idempotent) -------------------
  // The card sends the desired end-state. When every non-watch capability is
  // false, the relationship row is removed entirely.
  if (req.method === 'POST') {
    const assistantId = req.body?.assistantId;
    const principalId = req.body?.principalId;
    if (!assistantId || !principalId || typeof assistantId !== 'string' || typeof principalId !== 'string') {
      return res.status(400).json({ error: 'assistantId and principalId are required' });
    }
    if (assistantId === principalId) {
      return res.status(400).json({ error: 'A user cannot be their own assistant' });
    }

    // Confirm both users exist in the same org.
    const { data: found } = await supabaseAdmin
      .from('app_users')
      .select('id, display_name')
      .eq('organization_id', organizationId)
      .in('id', [assistantId, principalId]);
    if (!found || found.length !== 2) {
      return res.status(400).json({ error: 'Assistant or principal not found in your organization' });
    }

    const caps = {
      can_file: req.body?.can_file === true,
      can_upload: req.body?.can_upload === true,
      can_edit: req.body?.can_edit === true,
      can_withdraw: req.body?.can_withdraw === true,
      can_manage_notifications: req.body?.can_manage_notifications === true,
      can_gatekeep: req.body?.can_gatekeep === true,
    };
    const anyCapability = Object.values(caps).some(Boolean);

    // No capabilities left → remove the relationship row.
    if (!anyCapability) {
      const { error: delErr } = await supabaseAdmin
        .from('assistant_assignments')
        .delete()
        .eq('organization_id', organizationId)
        .eq('assistant_id', assistantId)
        .eq('principal_id', principalId);
      if (delErr) {
        console.error('assistant-assignments clear failed:', delErr);
        return res.status(500).json({ error: 'Failed to update assignment' });
      }
      await audit(req, user, {
        category: 'security',
        action: 'assistant_assignment.removed',
        targetType: 'user',
        targetId: assistantId,
        details: { principalId },
      });
      return res.status(200).json({ id: null, removed: true });
    }

    const { data, error } = await supabaseAdmin
      .from('assistant_assignments')
      .upsert(
        {
          organization_id: organizationId,
          assistant_id: assistantId,
          principal_id: principalId,
          created_by: user.id,
          ...caps,
        },
        { onConflict: 'assistant_id,principal_id' }
      )
      .select('id')
      .single();

    if (error) {
      console.error('assistant-assignments upsert failed:', error);
      return res.status(500).json({ error: 'Failed to save assignment' });
    }

    await audit(req, user, {
      category: 'security',
      action: 'assistant_assignment.updated',
      targetType: 'user',
      targetId: assistantId,
      details: { principalId, capabilities: caps },
    });

    return res.status(201).json({ id: data.id });
  }

  // ---- DELETE: remove ------------------------------------------------------
  if (req.method === 'DELETE') {
    const id = (req.query.id as string) || null;
    const assistantId = (req.query.assistantId as string) || null;
    const principalId = (req.query.principalId as string) || null;
    if (!id && !(assistantId && principalId)) {
      return res.status(400).json({ error: 'id, or both assistantId and principalId, are required' });
    }

    let query = supabaseAdmin
      .from('assistant_assignments')
      .delete()
      .eq('organization_id', organizationId);
    query = id
      ? query.eq('id', id)
      : query.eq('assistant_id', assistantId as string).eq('principal_id', principalId as string);

    const { error } = await query;
    if (error) {
      console.error('assistant-assignments remove failed:', error);
      return res.status(500).json({ error: 'Failed to remove assignment' });
    }

    await audit(req, user, {
      category: 'security',
      action: 'assistant_assignment.removed',
      targetType: 'user',
      targetId: assistantId || id,
      details: { principalId },
    });

    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
