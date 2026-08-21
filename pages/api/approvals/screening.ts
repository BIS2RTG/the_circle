import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getGatekeptPrincipals } from '@/lib/assistantAssignments';

/**
 * GET /api/approvals/screening
 *
 * The screening queue for a gatekeeping assistant: requests that have an
 * approval step parked in `pending_screen` whose approver is one of the
 * principals this assistant gatekeeps. Each item carries the parent request
 * (same shape as /api/approvals/pending) plus the screening step id and the
 * boss's name, so the Screening tab can offer Forward / Return actions.
 *
 * Returns [] when the caller gatekeeps no one.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = session.user as any;
    const userId = user.id;
    const organizationId = user.org_id;
    if (!organizationId) return res.status(200).json([]);

    // Which bosses does this assistant screen for?
    const principals = await getGatekeptPrincipals(userId, organizationId);
    if (principals.length === 0) return res.status(200).json([]);
    const principalIds = principals.map((p) => p.userId);
    const principalById = new Map(principals.map((p) => [p.userId, p]));

    // Steps currently awaiting screening for those bosses.
    const { data: screeningSteps, error: stepsError } = await supabaseAdmin
      .from('request_steps')
      .select('id, request_id, approver_user_id, step_index, activated_at, created_at')
      .eq('screening_status', 'pending_screen')
      .in('approver_user_id', principalIds);

    if (stepsError) {
      console.error('Error fetching screening steps:', stepsError);
      return res.status(500).json({ error: 'Failed to fetch screening queue' });
    }
    if (!screeningSteps || screeningSteps.length === 0) return res.status(200).json([]);

    const stepByRequest = new Map<string, any>();
    for (const s of screeningSteps) {
      // One active screening step per request in practice; keep the first.
      if (!stepByRequest.has(s.request_id)) stepByRequest.set(s.request_id, s);
    }
    const requestIds = [...stepByRequest.keys()];

    const { data: requests, error: reqError } = await supabaseAdmin
      .from('requests')
      .select(`
        id,
        organization_id,
        workspace_id,
        creator_id,
        title,
        description,
        status,
        metadata,
        created_at,
        updated_at,
        creator:app_users!requests_creator_id_fkey (
          id,
          display_name,
          email,
          profile_picture_url
        ),
        request_steps (
          id,
          step_index,
          step_type,
          approver_role,
          approver_user_id,
          status,
          screening_status,
          due_at,
          created_at,
          activated_at,
          first_viewed_at
        ),
        documents ( count )
      `)
      .in('id', requestIds)
      .in('status', ['pending', 'pending_approval'])
      .order('created_at', { ascending: false });

    if (reqError) {
      console.error('Error fetching screening requests:', reqError);
      return res.status(500).json({ error: 'Failed to fetch screening queue' });
    }

    // Attach the screening step id + boss identity so the UI can act on it.
    const enriched = (requests || []).map((r: any) => {
      const step = stepByRequest.get(r.id);
      const boss = principalById.get(step?.approver_user_id);
      return {
        ...r,
        screening_step_id: step?.id || null,
        screening_boss: boss ? { id: boss.userId, name: boss.name, email: boss.email } : null,
      };
    });

    return res.status(200).json(enriched);
  } catch (error: any) {
    console.error('Screening queue error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
