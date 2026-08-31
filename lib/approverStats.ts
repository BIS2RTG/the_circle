import { supabaseAdmin } from './supabaseAdmin';

export interface ApproverStats {
  pending: number;
  approved: number;
  rejected: number;
  total: number;
  completionRate: number;
}

/**
 * Stats from the signed-in user's perspective as an APPROVER, not a
 * requester: how many steps are awaiting their action, how many they've
 * approved/rejected, across their whole history. Excludes 'waiting' steps
 * (routed to them but not yet reached) and 'withdrawn'/'skipped' ones (pulled
 * before they acted), so "Total" only counts approvals they actually engaged with.
 */
export async function getApproverStats(userId: string): Promise<ApproverStats> {
  const { data: steps } = await supabaseAdmin
    .from('request_steps')
    .select('status')
    .eq('approver_user_id', userId)
    .in('status', ['pending', 'approved', 'rejected']);

  const all = steps || [];
  const pending = all.filter((s) => s.status === 'pending').length;
  const approved = all.filter((s) => s.status === 'approved').length;
  const rejected = all.filter((s) => s.status === 'rejected').length;
  const completed = approved + rejected;

  return {
    pending,
    approved,
    rejected,
    total: all.length,
    completionRate: completed > 0 ? Math.round((approved / completed) * 100) : 0,
  };
}
