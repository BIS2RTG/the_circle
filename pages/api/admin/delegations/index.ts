import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requirePermission, PERMISSIONS } from '@/lib/rbac';
import { audit } from '@/lib/auditLog';
import { sendUserNotificationEmail, escapeHtml } from '@/lib/notificationEmail';

/**
 * Admin delegation management.
 *
 *   GET  — list this org's delegations (active + past), newest first.
 *   POST — create a delegation (delegatorId, delegateId, reason, startsAt,
 *          endsAt, scope, requestIds?, attachmentCount). A 'specific' scope
 *          delegation covers ONLY the named requests — nothing else that lands
 *          on the delegator during the window is routed away. Steps already
 *          waiting on the delegator for those requests are moved immediately.
 *
 * Gated by admin.system_config OR users.manage_access. Every delegation
 * action is sealed into the immutable audit log.
 */

/** Allow either the system-config admin or a user-access manager. */
async function canManageDelegations(userId: string): Promise<boolean> {
  const a = await requirePermission(userId, PERMISSIONS.ADMIN_SYSTEM_CONFIG);
  if (a.allowed) return true;
  const b = await requirePermission(userId, PERMISSIONS.USERS_MANAGE_ACCESS);
  return b.allowed;
}

/** Derive the effective status shown to the client (active rows past their end are 'expired'). */
function effectiveStatus(row: { status: string; ends_at: string }): string {
  if (row.status === 'active' && new Date(row.ends_at).getTime() <= Date.now()) return 'expired';
  return row.status;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = session.user.id;
  const orgId = (session.user as any).org_id;
  if (!orgId) return res.status(400).json({ error: 'No organization found' });

  if (!(await canManageDelegations(userId))) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // ---- GET: list -----------------------------------------------------------
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('approval_delegations')
      .select(`
        id, reason, starts_at, ends_at, status, created_at, revoked_at, documents, scope, request_ids,
        delegator:app_users!delegator_id ( id, display_name, email, job_title ),
        delegate:app_users!delegate_id ( id, display_name, email, job_title ),
        created_by_user:app_users!created_by ( id, display_name )
      `)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('delegations list failed:', error);
      return res.status(500).json({ error: 'Failed to load delegations' });
    }

    // Attach a short-lived signed URL to each supporting document so the admin
    // UI can render thumbnails without a second round-trip.
    const delegations = await Promise.all(
      (data || []).map(async (d: any) => {
        const docs = Array.isArray(d.documents) ? d.documents : [];
        const documents = await Promise.all(
          docs.map(async (doc: any) => {
            try {
              const { data: signed } = await supabaseAdmin.storage
                .from('quotations')
                .createSignedUrl(doc.storage_path, 3600);
              return { ...doc, download_url: signed?.signedUrl || null };
            } catch {
              return { ...doc, download_url: null };
            }
          })
        );
        return { ...d, documents, status: effectiveStatus(d) };
      })
    );
    return res.status(200).json({ delegations });
  }

  // ---- POST: create --------------------------------------------------------
  if (req.method === 'POST') {
    const {
      delegatorId,
      delegateId,
      reason,
      startsAt,
      endsAt,
      scope,
      requestIds,
      attachmentCount,
      // Legacy body shape (pre-scope clients): treated as a 'specific' delegation.
      redirectRequestIds,
    } = req.body || {};

    const trimmedReason = (reason || '').trim();
    if (!delegatorId || !delegateId || !trimmedReason || !endsAt) {
      return res.status(400).json({ error: 'delegatorId, delegateId, reason and endsAt are required' });
    }
    if (delegatorId === delegateId) {
      return res.status(400).json({ error: 'The delegate must be a different person' });
    }

    // Supporting evidence is mandatory — a delegation moves someone's
    // signing authority, so the reason must be backed by a document.
    if (!Number.isInteger(attachmentCount) || attachmentCount < 1) {
      return res.status(400).json({ error: 'At least one supporting image is required' });
    }

    // Scope. 'specific' is the safe default for any caller that names requests;
    // 'all' must be asked for explicitly because it hands over every approval
    // that lands on the delegator during the window.
    const namedRequestIds: string[] = Array.from(
      new Set(
        (Array.isArray(requestIds) ? requestIds : Array.isArray(redirectRequestIds) ? redirectRequestIds : [])
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      )
    );
    const delegationScope = scope === 'all' ? 'all' : 'specific';
    if (delegationScope === 'specific' && namedRequestIds.length === 0) {
      return res.status(400).json({
        error: 'Choose at least one request to delegate, or switch the delegation to cover all approvals.',
      });
    }

    const starts = startsAt ? new Date(startsAt) : new Date();
    const ends = new Date(endsAt);
    if (isNaN(ends.getTime()) || ends.getTime() <= starts.getTime()) {
      return res.status(400).json({ error: 'End date must be after the start date' });
    }

    // Both users must belong to the caller's organization.
    const { data: users, error: usersError } = await supabaseAdmin
      .from('app_users')
      .select('id, display_name, email, organization_id')
      .in('id', [delegatorId, delegateId]);
    if (usersError || !users || users.length !== 2) {
      return res.status(404).json({ error: 'Delegator or delegate not found' });
    }
    if (users.some((u) => u.organization_id !== orgId)) {
      return res.status(400).json({ error: 'Both users must be in your organization' });
    }
    const delegator = users.find((u) => u.id === delegatorId)!;
    const delegate = users.find((u) => u.id === delegateId)!;

    // Guard against ambiguous overlapping delegations for the same delegator.
    // Two scoped delegations covering different requests are fine (an admin may
    // split cover between two people); anything that could route the same
    // approval two ways is not.
    const { data: existing } = await supabaseAdmin
      .from('approval_delegations')
      .select('id, scope, request_ids')
      .eq('delegator_id', delegatorId)
      .eq('status', 'active')
      .gt('ends_at', new Date().toISOString());

    for (const other of existing || []) {
      if (other.scope !== 'specific' || delegationScope !== 'specific') {
        return res.status(409).json({
          error: 'This person already has an active delegation covering all of their approvals. Revoke it first.',
        });
      }
      const overlap = namedRequestIds.filter((id) => (other.request_ids || []).includes(id));
      if (overlap.length > 0) {
        return res.status(409).json({
          error: `${overlap.length} of the selected request${overlap.length === 1 ? ' is' : 's are'} already delegated under another active delegation. Revoke that one first, or deselect them.`,
        });
      }
    }

    // Every named request must be in this org, and the delegate must not
    // already be an approver on it — otherwise one person would sign the same
    // request twice (the CFO-signs-the-CEO's-step breach).
    if (namedRequestIds.length > 0) {
      const { data: namedRequests } = await supabaseAdmin
        .from('requests')
        .select('id, organization_id')
        .in('id', namedRequestIds);
      const outOfOrg = namedRequestIds.filter(
        (id) => !(namedRequests || []).some((r) => r.id === id && r.organization_id === orgId)
      );
      if (outOfOrg.length > 0) {
        return res.status(400).json({ error: 'One or more selected requests are not in your organization' });
      }

      const { data: delegateSteps } = await supabaseAdmin
        .from('request_steps')
        .select('request_id')
        .in('request_id', namedRequestIds)
        .eq('approver_user_id', delegateId);

      const conflicting = Array.from(new Set((delegateSteps || []).map((s) => s.request_id)));
      if (conflicting.length > 0) {
        const { data: conflictRequests } = await supabaseAdmin
          .from('requests')
          .select('id, title, metadata')
          .in('id', conflicting);
        const labels = (conflictRequests || [])
          .map((r: any) => r.metadata?.referenceCode || r.title || r.id)
          .join(', ');
        return res.status(409).json({
          error: `${delegate.display_name || 'The delegate'} is already an approver on ${labels}. One person cannot approve the same request twice — remove ${conflicting.length === 1 ? 'it' : 'those'} from the selection or choose a different delegate.`,
        });
      }
    }

    const { data: created, error: insertError } = await supabaseAdmin
      .from('approval_delegations')
      .insert({
        organization_id: orgId,
        delegator_id: delegatorId,
        delegate_id: delegateId,
        reason: trimmedReason,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        status: 'active',
        created_by: userId,
        scope: delegationScope,
        request_ids: delegationScope === 'specific' ? namedRequestIds : [],
      })
      .select('id')
      .single();

    if (insertError || !created) {
      console.error('delegation insert failed:', insertError);
      return res.status(500).json({ error: 'Failed to create delegation' });
    }
    const delegationId = created.id;

    // Move the delegator's currently-pending steps on the named in-flight
    // requests to the delegate right away.
    let redirectedRequestIds: string[] = [];
    if (namedRequestIds.length > 0) {
      redirectedRequestIds = await redirectExistingRequests({
        requestIds: namedRequestIds,
        delegatorId,
        delegateId,
        adminId: userId,
        orgId,
        reason: trimmedReason,
        delegationId,
        delegatorName: delegator.display_name || 'the original approver',
        delegateName: delegate.display_name || 'the delegate',
      });
    }

    // Audit (immutable log).
    await audit(req, session.user, {
      category: 'workflow',
      action: 'delegation.created',
      severity: 'notice',
      targetType: 'user',
      targetId: delegatorId,
      targetLabel: delegator.display_name || delegator.email || delegatorId,
      details: {
        delegationId,
        delegateId,
        delegateName: delegate.display_name || delegate.email,
        reason: trimmedReason,
        startsAt: starts.toISOString(),
        endsAt: ends.toISOString(),
        scope: delegationScope,
        requestIds: namedRequestIds,
        redirectedRequestIds,
      },
    });

    // Notify the delegate (in-app task + email, best-effort). Say plainly how
    // wide the delegation is so nobody assumes more authority than was given.
    const scopeSentence =
      delegationScope === 'all'
        ? `You will handle every approval that reaches ${delegator.display_name || 'them'} until ${ends.toLocaleDateString('en-GB')}.`
        : `You will handle ${namedRequestIds.length} specific request${namedRequestIds.length === 1 ? '' : 's'} on behalf of ${delegator.display_name || 'them'} until ${ends.toLocaleDateString('en-GB')}. No other approvals are delegated to you.`;
    try {
      await supabaseAdmin.from('notifications').insert({
        organization_id: orgId,
        recipient_id: delegateId,
        sender_id: userId,
        type: 'task',
        title: 'You are now an approval delegate',
        message: `${scopeSentence} Reason: ${trimmedReason}`,
        metadata: { action_label: 'View my approvals', action_url: '/approvals', delegation_id: delegationId },
        is_read: false,
      });
      await sendUserNotificationEmail({
        userId: delegateId,
        actorUserId: userId,
        kind: 'approval_tasks',
        subject: 'You are now an approval delegate — The Circle',
        heading: 'Approval delegation assigned to you',
        bodyHtml: `<p>${escapeHtml(scopeSentence)}</p><p>Reason: ${escapeHtml(trimmedReason)}</p>`,
        actionUrl: '/approvals',
        actionLabel: 'View my approvals',
      });
    } catch (e) {
      console.error('delegation notify failed (non-fatal):', e);
    }

    return res.status(201).json({
      success: true,
      id: delegationId,
      scope: delegationScope,
      requestIds: namedRequestIds,
      redirectedRequestIds,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * Redirect the delegator's pending/waiting steps on specific requests to the
 * delegate, recording each in approval_redirections and notifying both people.
 * Returns the request ids that had at least one step redirected.
 */
async function redirectExistingRequests(args: {
  requestIds: string[];
  delegatorId: string;
  delegateId: string;
  adminId: string;
  orgId: string;
  reason: string;
  delegationId: string;
  delegatorName: string;
  delegateName: string;
}): Promise<string[]> {
  const redirected: string[] = [];
  const nowIso = new Date().toISOString();

  for (const requestId of args.requestIds) {
    // Segregation of duties: never move a step onto someone who already holds
    // or has signed another step of this request.
    const { data: delegateOwnSteps } = await supabaseAdmin
      .from('request_steps')
      .select('id')
      .eq('request_id', requestId)
      .eq('approver_user_id', args.delegateId)
      .limit(1);
    if (delegateOwnSteps && delegateOwnSteps.length > 0) {
      console.warn(
        `delegations: refused to redirect request ${requestId} to ${args.delegateId} — they already approve a step on it.`
      );
      continue;
    }

    // Only steps still on the delegator and still actionable.
    const { data: steps } = await supabaseAdmin
      .from('request_steps')
      .select('id, request_id, requests!inner(title, organization_id)')
      .eq('request_id', requestId)
      .eq('approver_user_id', args.delegatorId)
      .in('status', ['pending', 'waiting']);

    if (!steps || steps.length === 0) continue;

    let didRedirect = false;
    for (const step of steps as any[]) {
      if (step.requests?.organization_id !== args.orgId) continue;
      const { error: updErr } = await supabaseAdmin
        .from('request_steps')
        .update({
          approver_user_id: args.delegateId,
          is_redirected: true,
          original_approver_id: args.delegatorId,
          redirected_by_id: args.adminId,
          redirected_at: nowIso,
          redirect_reason: args.reason,
          delegation_id: args.delegationId,
        })
        .eq('id', step.id);
      if (updErr) {
        console.error('delegation redirect step failed:', updErr);
        continue;
      }
      await supabaseAdmin.from('approval_redirections').insert({
        request_id: requestId,
        step_id: step.id,
        original_approver_id: args.delegatorId,
        new_approver_id: args.delegateId,
        redirected_by_id: args.adminId,
        redirect_reason: args.reason,
      });
      didRedirect = true;

      // Notify the delegate that an approval was handed to them.
      await supabaseAdmin.from('notifications').insert({
        organization_id: args.orgId,
        recipient_id: args.delegateId,
        sender_id: args.adminId,
        type: 'task',
        title: 'Approval delegated to you',
        message: `An approval for "${step.requests?.title || 'a request'}" has been delegated to you (covering ${args.delegatorName}). Reason: ${args.reason}`,
        metadata: { request_id: requestId, action_label: 'Review Request', action_url: `/requests/${requestId}`, delegation_id: args.delegationId },
        is_read: false,
      });
    }

    if (didRedirect) {
      redirected.push(requestId);
      // Let the original approver know their pending item moved.
      await supabaseAdmin.from('notifications').insert({
        organization_id: args.orgId,
        recipient_id: args.delegatorId,
        sender_id: args.adminId,
        type: 'system',
        title: 'Your approval was delegated',
        message: `Your pending approval was delegated to ${args.delegateName}. Reason: ${args.reason}`,
        metadata: { request_id: requestId, action_label: 'View Request', action_url: `/requests/${requestId}`, delegation_id: args.delegationId },
        is_read: false,
      });
    }
  }

  return redirected;
}
