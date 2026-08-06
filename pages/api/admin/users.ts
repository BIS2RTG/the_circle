import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireAnyPermission, PERMISSIONS } from '@/lib/rbac';
import { audit } from '@/lib/auditLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const orgId = (session.user as any).org_id;
  if (!orgId) {
    return res.status(400).json({ error: 'No organization found' });
  }

  // GET — list all users with their roles, department, business unit
  if (req.method === 'GET') {
    const { allowed } = await requireAnyPermission(session.user.id, [
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_CREATE,
      PERMISSIONS.USERS_EDIT,
      PERMISSIONS.USERS_ASSIGN_ROLES,
    ]);
    if (!allowed) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    try {
      const { search, role_id } = req.query;

      // NOTE: department / business_unit master data lives in the separate HRIMS
      // project, not the app database — so there are no `departments` /
      // `business_units` tables to embed here. `is_active` / `last_sign_in_at`
      // are also not columns on app_users. We therefore select only native
      // app_users columns and treat every user as active.
      let query = supabaseAdmin
        .from('app_users')
        .select(`
          id,
          display_name,
          email,
          role,
          job_title,
          profile_picture_url,
          created_at,
          department_id,
          business_unit_id
        `)
        .eq('organization_id', orgId)
        .order('display_name', { ascending: true });

      // Search filter
      if (search) {
        const s = search as string;
        query = query.or(`display_name.ilike.%${s}%,email.ilike.%${s}%,job_title.ilike.%${s}%`);
      }

      const { data: users, error: usersError } = await query;

      if (usersError) {
        console.error('Error fetching users:', usersError);
        return res.status(500).json({ error: 'Failed to fetch users' });
      }

      // Fetch all user_roles with role info for these users
      const userIds = (users || []).map((u: any) => u.id);

      let userRolesData: any[] = [];
      if (userIds.length > 0) {
        const { data: rolesData, error: rolesError } = await supabaseAdmin
          .from('user_roles')
          .select(`
            user_id,
            role_id,
            is_active,
            expires_at,
            role:roles(id, name, slug, color, priority, is_system, is_default)
          `)
          .in('user_id', userIds)
          .eq('is_active', true);

        if (!rolesError) {
          userRolesData = rolesData || [];
        }
      }

      // Group roles by user_id
      const rolesByUser: Record<string, any[]> = {};
      userRolesData.forEach((ur: any) => {
        if (!rolesByUser[ur.user_id]) rolesByUser[ur.user_id] = [];
        if (ur.role) rolesByUser[ur.user_id].push(ur.role);
      });

      // Data-access scope per user, so the Access & Rights table can show each
      // user's visibility level at a glance. Absence of a row = the default
      // (home business unit).
      const scopeByUser: Record<string, { level: string; bu_count: number }> = {};
      if (userIds.length > 0) {
        const { data: scopeRows } = await supabaseAdmin
          .from('user_access_scopes')
          .select('id, user_id, scope_level')
          .in('user_id', userIds);
        const scopeIdByUser: Record<string, string> = {};
        for (const s of scopeRows || []) {
          scopeByUser[s.user_id] = { level: s.scope_level, bu_count: 0 };
          scopeIdByUser[s.user_id] = s.id;
        }
        const scopeIds = (scopeRows || []).map((s: any) => s.id);
        if (scopeIds.length > 0) {
          const { data: buRows } = await supabaseAdmin
            .from('user_scope_business_units')
            .select('scope_id')
            .in('scope_id', scopeIds);
          const countByScope: Record<string, number> = {};
          for (const b of buRows || []) countByScope[b.scope_id] = (countByScope[b.scope_id] || 0) + 1;
          for (const uid of Object.keys(scopeIdByUser)) {
            if (scopeByUser[uid]) scopeByUser[uid].bu_count = countByScope[scopeIdByUser[uid]] || 0;
          }
        }
      }

      // If filtering by role_id, keep only users who have that role
      let enrichedUsers = (users || []).map((user: any) => ({
        ...user,
        is_active: true,        // app_users has no is_active column — treat as active
        department: null,       // department names come from HRIMS, not the app DB
        business_unit: null,
        roles: rolesByUser[user.id] || [],
        primary_role: (rolesByUser[user.id] || []).sort((a: any, b: any) => b.priority - a.priority)[0] || null,
        access_scope_level: scopeByUser[user.id]?.level || null,
        access_scope_bu_count: scopeByUser[user.id]?.bu_count || 0,
      }));

      if (role_id) {
        enrichedUsers = enrichedUsers.filter((u: any) =>
          u.roles.some((r: any) => r.id === role_id)
        );
      }

      // Stats
      const stats = {
        total: enrichedUsers.length,
        active: enrichedUsers.length,
        inactive: 0,
      };

      return res.status(200).json({ users: enrichedUsers, stats });
    } catch (err) {
      console.error('Error in admin users GET:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // PUT — update a user (status, role, department, etc.)
  if (req.method === 'PUT') {
    const { allowed } = await requireAnyPermission(session.user.id, [
      PERMISSIONS.USERS_EDIT,
      PERMISSIONS.USERS_DEACTIVATE,
    ]);
    if (!allowed) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    try {
      const { user_id, department_id, business_unit_id, job_title } = req.body;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      // NOTE: `is_active` is intentionally ignored — app_users has no such column.
      const updatePayload: Record<string, any> = {};
      if (department_id !== undefined) updatePayload.department_id = department_id;
      if (business_unit_id !== undefined) updatePayload.business_unit_id = business_unit_id;
      if (job_title !== undefined) updatePayload.job_title = job_title;

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const { data, error } = await supabaseAdmin
        .from('app_users')
        .update(updatePayload)
        .eq('id', user_id)
        .eq('organization_id', orgId)
        .select()
        .single();

      if (error) {
        console.error('Error updating user:', error);
        return res.status(400).json({ error: error.message });
      }

      await audit(req, session.user, {
        category: 'security',
        action: 'user.updated',
        severity: 'notice',
        targetType: 'user',
        targetId: user_id,
        targetLabel: data?.display_name || data?.email || null,
        details: { changes: updatePayload },
      });

      return res.status(200).json({ success: true, user: data });
    } catch (err) {
      console.error('Error in admin users PUT:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
