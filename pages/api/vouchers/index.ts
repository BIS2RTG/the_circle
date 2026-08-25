import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from '@/lib/rbac';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = session.user as any;
    const organizationId = user.org_id;
    const userId = user.id;

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    // Only users with the voucher-register permission (or a super admin) may
    // view the voucher generation records.
    const profile = await getUserRBACProfile(userId);
    if (!hasPermission(profile, PERMISSIONS.VOUCHERS_VIEW_REGISTER)) {
      return res.status(403).json({ error: 'You do not have permission to view the voucher register' });
    }

    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('vouchers')
        .select(`
          id,
          seq,
          voucher_number,
          guest_names,
          business_units,
          reason,
          email_sent,
          email_sent_at,
          email_recipients,
          delivered,
          delivered_at,
          delivered_by,
          created_at,
          request:requests!vouchers_request_id_fkey (
            id,
            title,
            status,
            created_at,
            creator:app_users!requests_creator_id_fkey ( id, display_name, email )
          )
        `)
        .eq('organization_id', organizationId)
        .order('seq', { ascending: false, nullsFirst: true })
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Voucher numbers are derived from the request id (no org-wide counter):
      // base `VCH-<first 8 of request id>`, with a range suffix when the request
      // generates several. This mirrors what the downloaded voucher shows.
      const vouchers = (data || []).map((v: any) => {
        const reqObj = Array.isArray(v.request) ? v.request[0] : v.request;
        const reqId = reqObj?.id || '';
        const units = Array.isArray(v.business_units) ? v.business_units : [];
        const counts = units
          .map((u: any) => parseInt(String(u?.numberOfVouchers ?? ''), 10))
          .filter((n: number) => Number.isFinite(n) && n > 0);
        const count = counts.length ? Math.min(100, Math.max(...counts)) : 1;
        // The number only exists once the request is approved (matches the
        // downloadable voucher). Pending requests stay "pending" on the register.
        const base = reqId ? `VCH-${String(reqId).substring(0, 8).toUpperCase()}` : null;
        const display = reqObj?.status === 'approved' && base
          ? (count > 1 ? `${base}-01…-${String(count).padStart(2, '0')}` : base)
          : null;
        return { ...v, voucher_number: display, voucher_count: count };
      });

      return res.status(200).json({ vouchers });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Vouchers API error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load vouchers' });
  }
}
