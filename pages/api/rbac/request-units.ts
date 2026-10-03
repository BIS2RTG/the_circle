import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireAnyPermission, logRBACAction } from '@/lib/rbac';
import { getAssignedRequestBusinessUnits, getRequestBusinessUnits } from '@/lib/requestBusinessUnits';

// Business units a Multi-Unit Requester may file for (see lib/requestBusinessUnits).
//
// GET  /api/rbac/request-units            → caller's usable units (empty without the permission)
// GET  /api/rbac/request-units?user_id=X  → X's ticked units (admins only, for the editor)
// PUT  /api/rbac/request-units            → replace a user's units (admins only)
//      body: { user_id, units: [{ code, name }] }
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) return res.status(401).json({ error: 'Unauthorized' });

  const callerId = session.user.id;
  const orgId = (session.user as any).org_id;
  if (!orgId) return res.status(400).json({ error: 'No organization found' });

  if (req.method === 'GET') {
    try {
      const targetId = typeof req.query.user_id === 'string' ? req.query.user_id : null;
      if (!targetId || targetId === callerId) {
        const units = await getRequestBusinessUnits(callerId);
        return res.status(200).json({ units });
      }

      const { allowed } = await requireAnyPermission(callerId, ['users.manage_access', 'users.assign_roles']);
      if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });

      const units = await getAssignedRequestBusinessUnits(targetId);
      return res.status(200).json({ units });
    } catch (err: any) {
      console.error('rbac/request-units GET error:', err);
      return res.status(500).json({ error: err?.message || 'Failed to load business units' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { allowed } = await requireAnyPermission(callerId, ['users.manage_access', 'users.assign_roles']);
      if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });

      const { user_id, units } = req.body || {};
      if (!user_id || !Array.isArray(units)) {
        return res.status(400).json({ error: 'user_id and units are required' });
      }

      // The target must belong to the caller's organization.
      const { data: target } = await supabaseAdmin
        .from('app_users')
        .select('id')
        .eq('id', user_id)
        .eq('organization_id', orgId)
        .maybeSingle();
      if (!target) return res.status(404).json({ error: 'User not found' });

      const byCode = new Map<string, string>();
      for (const u of units) {
        const code = String(u?.code || '').trim();
        const name = String(u?.name || '').trim();
        if (code && name) byCode.set(code.toUpperCase(), name);
      }

      const { error: delErr } = await supabaseAdmin
        .from('user_request_business_units')
        .delete()
        .eq('user_id', user_id);
      if (delErr) return res.status(500).json({ error: delErr.message });

      if (byCode.size > 0) {
        const { error: insErr } = await supabaseAdmin.from('user_request_business_units').insert(
          Array.from(byCode.entries()).map(([code, name]) => ({
            user_id,
            organization_id: orgId,
            business_unit_code: code,
            business_unit_name: name,
            assigned_by: callerId,
          }))
        );
        if (insErr) return res.status(500).json({ error: insErr.message });
      }

      await logRBACAction(callerId, 'request_business_units_updated', 'user', user_id, {
        business_units: Array.from(byCode.keys()),
      });

      return res.status(200).json({ success: true, units: await getAssignedRequestBusinessUnits(user_id) });
    } catch (err: any) {
      console.error('rbac/request-units PUT error:', err);
      return res.status(500).json({ error: err?.message || 'Failed to save business units' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
