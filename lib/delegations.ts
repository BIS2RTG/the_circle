/**
 * Approval delegation lookup (approval_delegations table).
 *
 * A delegation routes approvals that would land on the delegator to the
 * delegate for a bounded window. Its `scope` decides how wide that is:
 *
 *   'all'      — every approval for the delegator during the window
 *   'specific' — only the requests listed in `request_ids`
 *
 * The approval engine calls getActiveDelegateFor() whenever it resolves or
 * activates an approver, always passing the request in hand so a scoped
 * delegation can never leak onto a request it does not name.
 *
 * Read only through the service role. Every reader is best-effort: a lookup
 * failure returns "no delegation" so a workflow action can never break.
 */

import { supabaseAdmin } from './supabaseAdmin';

export interface ActiveDelegation {
  id: string;
  delegator_id: string;
  delegate_id: string;
  reason: string;
  created_by: string | null;
  starts_at: string;
  ends_at: string;
  scope: string;
  request_ids: string[] | null;
}

/**
 * Return the delegate currently covering `delegatorId` for `requestId`, or
 * null. A delegation is in force when status='active', now ∈ [starts_at,
 * ends_at] and its scope covers this request. Only a single hop is followed
 * (if the delegate is themselves delegated we do not chain) to keep routing
 * predictable and loop-free.
 *
 * `requestId` is required for a scoped delegation to match. Callers that
 * genuinely have no request in hand pass null and only ever match an
 * organisation-wide ('all') delegation.
 */
export async function getActiveDelegateFor(
  delegatorId: string | null | undefined,
  organizationId: string | null | undefined,
  requestId: string | null | undefined,
  at: Date = new Date()
): Promise<ActiveDelegation | null> {
  if (!delegatorId) return null;
  try {
    const nowIso = at.toISOString();
    let query = supabaseAdmin
      .from('approval_delegations')
      .select('id, delegator_id, delegate_id, reason, created_by, starts_at, ends_at, scope, request_ids')
      .eq('delegator_id', delegatorId)
      .eq('status', 'active')
      .lte('starts_at', nowIso)
      .gt('ends_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(10);
    if (organizationId) query = query.eq('organization_id', organizationId);

    const { data, error } = await query;
    if (error) {
      console.warn('delegations: lookup failed, treating as none:', error.message);
      return null;
    }
    if (!data || data.length === 0) return null;

    // Newest delegation whose scope actually covers this request wins.
    const match = (data as ActiveDelegation[]).find((d) => {
      // Defensive: never route back to the same person.
      if (d.delegate_id === d.delegator_id) return false;
      if (d.scope !== 'specific') return true;
      if (!requestId) return false;
      return Array.isArray(d.request_ids) && d.request_ids.includes(requestId);
    });

    return match || null;
  } catch (e) {
    console.warn('delegations: lookup threw, treating as none:', e);
    return null;
  }
}

/**
 * True when `delegateId` already holds (or has already signed) another step on
 * `requestId`. Routing a further step to them would let one person sign the
 * same request twice — the exact segregation-of-duties breach that let a CFO
 * complete a CAPEX that still needed the CEO. Callers must refuse to delegate
 * when this returns true.
 *
 * Fails CLOSED: if the check itself errors we report a conflict, because
 * leaving the step with its original approver is always the safe outcome.
 */
export async function delegateWouldSignTwice(
  requestId: string | null | undefined,
  delegateId: string | null | undefined,
  excludeStepId?: string | null
): Promise<boolean> {
  if (!requestId || !delegateId) return false;
  try {
    let query = supabaseAdmin
      .from('request_steps')
      .select('id')
      .eq('request_id', requestId)
      .eq('approver_user_id', delegateId)
      .limit(1);
    if (excludeStepId) query = query.neq('id', excludeStepId);

    const { data, error } = await query;
    if (error) {
      console.warn('delegations: conflict check failed, refusing to delegate:', error.message);
      return true;
    }
    return (data || []).length > 0;
  } catch (e) {
    console.warn('delegations: conflict check threw, refusing to delegate:', e);
    return true;
  }
}
