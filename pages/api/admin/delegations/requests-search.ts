import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requirePermission, PERMISSIONS } from '@/lib/rbac';

/**
 * GET /api/admin/delegations/requests-search
 *      ?delegatorId=<uuid>&delegateId=<uuid>&q=<text>
 *
 * The live requests a delegation could cover: everything the delegator is
 * still due to approve (a pending step now, or a waiting step later in the
 * chain). Used by the "which requests?" picker in the new-delegation form.
 *
 * `q` matches across request id, reference code, title, description, request
 * type and the requester's name/email — so an admin can paste an id, type a
 * colleague's surname, or search wording from the request itself.
 *
 * `delegateId` is optional; when given, each row is flagged with whether that
 * person already approves a step on the request. Delegating such a request
 * would let one person sign it twice, so the UI blocks selecting it.
 */
async function canManageDelegations(userId: string): Promise<boolean> {
  const a = await requirePermission(userId, PERMISSIONS.ADMIN_SYSTEM_CONFIG);
  if (a.allowed) return true;
  const b = await requirePermission(userId, PERMISSIONS.USERS_MANAGE_ACCESS);
  return b.allowed;
}

/** Human label for a request type slug ("travel_auth" -> "Travel Auth"). */
function prettyType(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const userId = session.user.id;
  const orgId = (session.user as any).org_id;
  if (!orgId) return res.status(400).json({ error: 'No organization found' });

  if (!(await canManageDelegations(userId))) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const { delegatorId, delegateId, q } = req.query;
  if (typeof delegatorId !== 'string') {
    return res.status(400).json({ error: 'delegatorId is required' });
  }
  const term = (typeof q === 'string' ? q : '').trim().toLowerCase();

  // Everything still on the delegator's plate, now or later in the chain.
  const { data: steps, error } = await supabaseAdmin
    .from('request_steps')
    .select(`
      id, step_index, status,
      request:requests!inner (
        id, title, description, status, metadata, created_at, organization_id,
        creator:app_users!creator_id ( id, display_name, email, job_title )
      )
    `)
    .eq('approver_user_id', delegatorId)
    .in('status', ['pending', 'waiting'])
    .eq('request.status', 'pending');

  if (error) {
    console.error('delegations request search failed:', error);
    return res.status(500).json({ error: 'Failed to search requests' });
  }

  // Collapse to one row per request, keeping the earliest step on the delegator.
  const byRequest = new Map<string, any>();
  for (const step of (steps as any[]) || []) {
    const request = step.request;
    if (!request || request.organization_id !== orgId) continue;
    const existing = byRequest.get(request.id);
    if (existing && existing.stepIndex <= step.step_index) continue;

    const meta = request.metadata || {};
    byRequest.set(request.id, {
      requestId: request.id,
      title: request.title || 'Untitled request',
      description: request.description || null,
      referenceCode: meta.referenceCode || null,
      requestType: prettyType(meta.type || meta.requestType),
      amount: meta.totalAmount ?? meta.amount ?? null,
      currency: meta.currency || null,
      requesterName: request.creator?.display_name || null,
      requesterEmail: request.creator?.email || null,
      requesterTitle: request.creator?.job_title || null,
      createdAt: request.created_at,
      stepIndex: step.step_index,
      stepStatus: step.status,
      // 'pending' = sitting on the delegator's desk right now.
      awaitingNow: step.status === 'pending',
    });
  }

  let results = Array.from(byRequest.values());

  // Free-text filter across everything an admin might remember about a request.
  if (term) {
    results = results.filter((r) => {
      const haystack = [
        r.requestId,
        r.title,
        r.description,
        r.referenceCode,
        r.requestType,
        r.requesterName,
        r.requesterEmail,
        r.requesterTitle,
        r.amount != null ? String(r.amount) : null,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }

  // Flag requests the prospective delegate already approves — selecting one
  // would make a single person sign the same request twice.
  if (typeof delegateId === 'string' && delegateId && results.length > 0) {
    const { data: conflicts } = await supabaseAdmin
      .from('request_steps')
      .select('request_id')
      .in('request_id', results.map((r) => r.requestId))
      .eq('approver_user_id', delegateId);
    const conflicting = new Set((conflicts || []).map((c: any) => c.request_id));
    results = results.map((r) => ({ ...r, delegateConflict: conflicting.has(r.requestId) }));
  } else {
    results = results.map((r) => ({ ...r, delegateConflict: false }));
  }

  // Waiting-on-them-now first, then newest.
  results.sort((a, b) => {
    if (a.awaitingNow !== b.awaitingNow) return a.awaitingNow ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return res.status(200).json({ requests: results.slice(0, 100), total: results.length });
}
