import { supabaseAdmin } from './supabaseAdmin';
import { getRequestTypeLabel } from './requestCode';
import { fanoutToNotificationAssistants, getGatekeepersFor } from './assistantAssignments';
import { sendUserNotificationEmail, escapeHtml, appBaseUrl } from './notificationEmail';
import { approvalLinkUrl } from './approvalLinkToken';

/**
 * Shared approval-step construction for form requests.
 *
 * Form requests don't carry a workflow_definition_id — their approver chain is
 * the ordered `metadata.approvers` list the requester picked. Historically the
 * "turn approvers into request_steps + notify" logic was duplicated across
 * `POST /api/requests`, `POST /api/requests/[id]/publish` and the
 * resubmit-after-unsubmit path. This module is the single source of truth so
 * every entry point builds steps + notifies identically.
 */

/**
 * Normalise `metadata.approvers` (array OR legacy role→id object) into an
 * ordered list of approver user ids.
 */
export function normalizeApprovers(metadata: any): string[] {
  const approversData = metadata?.approvers;
  if (!approversData) return [];

  if (Array.isArray(approversData)) {
    return approversData.filter((id: any) => typeof id === 'string' && id.length > 0);
  }

  if (typeof approversData === 'object') {
    const approverObj = approversData as Record<string, string>;
    const orderedKeys = [
      // Petty cash roles (canonical sequential order first)
      'department_head', 'accountant',
      // CAPEX roles
      'finance_manager', 'general_manager', 'procurement_manager', 'corporate_hod',
      'projects_manager', 'managing_director',
      // Travel / Hotel Booking roles
      'line_manager', 'functional_head', 'hod', 'hrd', 'hr_director', 'finance_director', 'ceo',
      // Voucher request roles
      'commercial_director',
      // Generic fallback roles
      'manager', 'director',
    ];
    const result: string[] = [];
    for (const key of orderedKeys) {
      if (approverObj[key] && !result.includes(approverObj[key])) result.push(approverObj[key]);
    }
    for (const [key, value] of Object.entries(approverObj)) {
      if (value && !orderedKeys.includes(key) && !result.includes(value)) result.push(value);
    }
    return result;
  }

  return [];
}

export interface BuildStepsParams {
  requestId: string;
  organizationId: string;
  creatorId: string;
  title: string;
  metadata: any;
  requestType?: string;
}

export interface BuildStepsResult {
  success: boolean;
  error?: string;
  approverCount?: number;
  /** Final ordered approver ids actually written as steps. */
  approverIds?: string[];
}

/**
 * Build request_steps from the request's approvers, notify the relevant
 * approver(s), and stamp step-tracking metadata. For executive travel the CHCO
 * is resolved server-side and prepended as the mandatory first (costing) step.
 *
 * Assumes the request row already exists and is transitioning into `pending`.
 */
export async function buildAndNotifySteps(params: BuildStepsParams): Promise<BuildStepsResult> {
  const { requestId, organizationId, creatorId, title, metadata } = params;
  const requestType = params.requestType || metadata?.requestType || metadata?.type || 'general';

  const approverIds = normalizeApprovers(metadata);

  if (approverIds.length === 0) {
    return { success: false, error: 'No approvers assigned. Please add approvers before submitting.' };
  }

  // Integrity guard: the requester can never approve their own request. This is
  // the authoritative backstop for every entry point (create / publish /
  // resubmit) and every form — the pickers also hide the requester, but a
  // crafted payload or a stale draft must still be refused here.
  if (approverIds.includes(creatorId)) {
    return {
      success: false,
      error: 'You cannot add yourself as an approver on your own request. Please remove yourself from the approver list.',
    };
  }

  const useParallelApprovals = metadata?.useParallelApprovals === true;
  const nowIso = new Date().toISOString();

  const requestSteps = approverIds.map((approverId, index) => {
    const isPendingNow = useParallelApprovals || index === 0;
    return {
      request_id: requestId,
      step_index: index + 1,
      step_type: 'approval',
      approver_user_id: approverId,
      status: isPendingNow ? 'pending' : 'waiting',
      // "Received on this approver's desk" — stamped when the step is active.
      activated_at: isPendingNow ? nowIso : null,
    };
  });

  const { data: insertedSteps, error: stepsError } = await supabaseAdmin
    .from('request_steps')
    .insert(requestSteps)
    .select('id, step_index, approver_user_id, status');
  if (stepsError || !insertedSteps) {
    console.error('Failed to create request_steps:', stepsError);
    return { success: false, error: 'Failed to create approval steps' };
  }

  // Requester name for notifications.
  const { data: requesterData } = await supabaseAdmin
    .from('app_users')
    .select('display_name')
    .eq('id', creatorId)
    .single();
  const requesterName = requesterData?.display_name || 'A user';
  const requestTypeLabel = getRequestTypeLabel(requestType);

  const actionUrl = `/requests/${requestId}`;
  const base = appBaseUrl();
  const stepWord = useParallelApprovals
    ? `Parallel approval — ${approverIds.length} approvers`
    : `Step 1 of ${approverIds.length}`;

  // Notify the approver(s) whose step is ACTIVE now — derived from the step
  // status so it can never diverge from who actually needs to act. Sequential
  // requests notify only the first approver; later approvers are notified by the
  // ApprovalEngine as their step becomes pending. Parallel requests notify all.
  //
  // GATEKEEPING: if an active approver has one or more gatekeeping assistants
  // (assistant_assignments.can_gatekeep), the request must be SCREENED before it
  // reaches that approver. We park the step in `pending_screen` and notify the
  // gatekeeper(s) instead — the approver is not notified until the request is
  // forwarded. This mirrors ApprovalEngine.announceStepForApproval so both the
  // workflow-definition path and the form path behave identically.
  const activeSteps = insertedSteps.filter((s) => s.status === 'pending');
  for (const step of activeSteps) {
    const approverId = step.approver_user_id;
    const stepNumber = step.step_index;

    const gatekeepers = await getGatekeepersFor(approverId, organizationId);
    if (gatekeepers.length > 0) {
      // Park the step so it never surfaces on the approver's desk yet.
      await supabaseAdmin
        .from('request_steps')
        .update({ screening_status: 'pending_screen' })
        .eq('id', step.id);
      await notifyGatekeepersForStep({
        gatekeepers,
        approverId,
        requestId,
        organizationId,
        senderId: creatorId,
        requesterName,
        requestTypeLabel,
        title,
        base,
      });
      continue;
    }

    // Normal path — notify the approver directly (in-app task + assistants + email).
    const message = useParallelApprovals
      ? `${requesterName} has submitted a ${requestTypeLabel} request "${title}" for your approval. (Parallel approval - ${approverIds.length} approvers)`
      : `${requesterName} has submitted a ${requestTypeLabel} request "${title}" for your approval. (Step ${stepNumber} of ${approverIds.length})`;
    const notifMetadata: Record<string, any> = {
      request_id: requestId,
      request_type: requestType,
      action_label: 'Review Request',
      action_url: actionUrl,
      step_number: stepNumber,
      total_steps: approverIds.length,
      ...(useParallelApprovals ? { is_parallel: true } : {}),
    };

    try {
      await supabaseAdmin.from('notifications').insert({
        organization_id: organizationId,
        recipient_id: approverId,
        sender_id: creatorId,
        type: 'task',
        title: 'New Approval Request',
        message,
        metadata: notifMetadata,
        is_read: false,
      });
    } catch (notifError) {
      console.error('Failed to create notification:', notifError);
    }
    // Copy the approval task to the approver's notification-managing assistants.
    await fanoutToNotificationAssistants(approverId, organizationId, {
      type: 'task',
      title: 'New Approval Request',
      message,
      senderId: creatorId,
      metadata: notifMetadata,
    });
    // Email the approver — sent as the requester (actorUserId) so it rides the
    // delegated Graph transport. Preference-gated and non-fatal. Magic link
    // signs the approver in from the email straight onto the request to sign.
    await sendUserNotificationEmail({
      userId: approverId,
      actorUserId: creatorId,
      kind: 'approval_tasks',
      subject: `Approval required: ${title}`,
      heading: 'A request is waiting for your approval',
      bodyHtml: `<p>${escapeHtml(`${requesterName} has submitted a ${requestTypeLabel} request "${title}" for your approval. (${stepWord})`)}</p>`,
      actionUrl: approvalLinkUrl(base, approverId, requestId),
      actionLabel: 'Review & Sign',
    });
  }

  // Stamp step-tracking metadata (merged over whatever is already stored).
  const { data: current } = await supabaseAdmin
    .from('requests')
    .select('metadata')
    .eq('id', requestId)
    .single();

  const mergedMetadata: Record<string, any> = {
    ...(current?.metadata || {}),
    total_steps: approverIds.length,
    current_step: useParallelApprovals ? null : 1,
    useParallelApprovals,
  };

  await supabaseAdmin.from('requests').update({ metadata: mergedMetadata }).eq('id', requestId);

  return { success: true, approverCount: approverIds.length, approverIds };
}

/**
 * Notify a gatekeeping assistant (or assistants) that an incoming approval for
 * their principal is waiting to be SCREENED — with an in-app task + email that
 * deep-links to the Screening tab. The principal (boss) is intentionally NOT
 * notified; they only hear about it once the request is forwarded.
 */
async function notifyGatekeepersForStep(args: {
  gatekeepers: string[];
  approverId: string;
  requestId: string;
  organizationId: string;
  senderId: string;
  requesterName: string;
  requestTypeLabel: string;
  title: string;
  base: string;
}): Promise<void> {
  const {
    gatekeepers, approverId, requestId, organizationId,
    senderId, requesterName, requestTypeLabel, title, base,
  } = args;

  const { data: boss } = await supabaseAdmin
    .from('app_users')
    .select('display_name, email')
    .eq('id', approverId)
    .maybeSingle();
  const bossName = boss?.display_name || boss?.email || 'the person you assist';

  const message =
    `${requesterName} submitted a ${requestTypeLabel} request "${title}" that needs ${bossName}'s approval. ` +
    `Screen it first, then either forward it to ${bossName} or return it to the requester with a comment.`;
  const metadata = {
    request_id: requestId,
    screening: true,
    principal_id: approverId,
    action_label: 'Screen Request',
    action_url: '/approvals?tab=screening',
  };

  for (const gatekeeperId of gatekeepers) {
    try {
      await supabaseAdmin.from('notifications').insert({
        organization_id: organizationId,
        recipient_id: gatekeeperId,
        sender_id: senderId,
        type: 'task',
        title: `Screen a request for ${bossName}`,
        message,
        metadata,
        is_read: false,
      });
    } catch (error) {
      console.error('Failed to notify gatekeeper:', error);
    }

    await sendUserNotificationEmail({
      userId: gatekeeperId,
      actorUserId: senderId,
      kind: 'approval_tasks',
      subject: `Screen a request for ${bossName} — The Circle`,
      heading: `A request is waiting to be screened for ${escapeHtml(bossName)}`,
      bodyHtml: `<p>${escapeHtml(message)}</p>`,
      actionUrl: `${base}/approvals?tab=screening`,
      actionLabel: 'Screen the request',
    });
  }
}
