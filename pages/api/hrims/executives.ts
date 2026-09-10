import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveExecutives } from '@/lib/executives';

/**
 * GET /api/hrims/executives
 *
 * Returns the executives (the CEO + direct CEO reports, resolved from HRIMS)
 * that the current user may file forms on behalf of — i.e. those who hold an
 * active delegation naming this user as their delegate. Used by the
 * "File on behalf of…" field on the request forms.
 *
 * Empty array is a normal response (no HRIMS, no executives, or no delegations).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    const executives = await resolveExecutives(organizationId);
    if (executives.length === 0) {
      return res.status(200).json({ executives: [] });
    }

    // Keep only executives who have delegated to the current user right now.
    // Only a full ('all') delegation confers the right to file on their behalf:
    // a delegation scoped to a handful of named approvals hands over exactly
    // those signatures, not the authority to raise new requests as that person.
    const nowIso = new Date().toISOString();
    const { data: delegations, error } = await supabaseAdmin
      .from('approval_delegations')
      .select('delegator_id')
      .eq('organization_id', organizationId)
      .eq('delegate_id', userId)
      .eq('status', 'active')
      .eq('scope', 'all')
      .lte('starts_at', nowIso)
      .gte('ends_at', nowIso);

    if (error) {
      console.error('Failed to load delegations for executives list:', error);
      return res.status(200).json({ executives: [] });
    }

    const delegatorIds = new Set((delegations || []).map((d: any) => d.delegator_id));
    const eligible = executives
      .filter((e) => e.userId !== userId && delegatorIds.has(e.userId))
      .map((e) => ({
        userId: e.userId,
        name: e.displayName,
        positionTitle: e.positionTitle,
        email: e.email,
      }));

    return res.status(200).json({ executives: eligible });
  } catch (error: any) {
    console.error('Executives lookup error:', error);
    return res.status(200).json({ executives: [] });
  }
}
