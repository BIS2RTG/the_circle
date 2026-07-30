import { supabaseAdmin } from './supabaseAdmin';

/**
 * Assistant assignments.
 *
 * A systems admin nominates an "assistant" who may act for one or more
 * "principals". Each assistant→principal record carries granular capability
 * flags (file / upload / edit / withdraw / manage-notifications). This module
 * resolves those relationships for the on-behalf gate (see lib/onBehalf.ts),
 * the on-behalf field's picker, and the per-capability enforcement gates.
 *
 * The "watch" (read-only visibility) capability lives in permanent_watchers,
 * not here.
 */

export type AssistantCapability =
  | 'can_file'
  | 'can_upload'
  | 'can_edit'
  | 'can_withdraw'
  | 'can_manage_notifications'
  | 'can_gatekeep';

export interface AssistantCapabilities {
  can_file: boolean;
  can_upload: boolean;
  can_edit: boolean;
  can_withdraw: boolean;
  can_manage_notifications: boolean;
  can_gatekeep: boolean;
}

export interface AssignedPrincipal {
  userId: string;
  name: string;
  email: string;
  positionTitle: string;
}

/**
 * The principals `assistantId` may **file** on behalf of (can_file = true),
 * mapped to app_users for display. Returns [] (never throws) so callers can
 * treat "no assignments" as a normal empty state.
 */
export async function getPrincipalsForAssistant(
  assistantId: string,
  organizationId: string
): Promise<AssignedPrincipal[]> {
  if (!assistantId || !organizationId) return [];

  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('principal:app_users!assistant_assignments_principal_id_fkey ( id, display_name, email, job_title )')
    .eq('organization_id', organizationId)
    .eq('assistant_id', assistantId)
    .eq('can_file', true);

  if (error) {
    console.error('getPrincipalsForAssistant failed:', error);
    return [];
  }

  return (data || [])
    .map((row: any) => row.principal)
    .filter(Boolean)
    .map((p: any) => ({
      userId: p.id,
      name: p.display_name || p.email,
      email: p.email,
      positionTitle: p.job_title || '',
    }));
}

/** Whether `assistantId` may file on behalf of `principalId` (can_file = true). */
export async function canFileOnBehalfOf(
  assistantId: string,
  principalId: string,
  organizationId: string
): Promise<boolean> {
  if (!assistantId || !principalId || !organizationId) return false;
  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('assistant_id', assistantId)
    .eq('principal_id', principalId)
    .eq('can_file', true)
    .limit(1);

  if (error) {
    console.error('canFileOnBehalfOf query failed:', error);
    return false;
  }
  return (data?.length || 0) > 0;
}

/**
 * The capability flags `assistantId` holds for `principalId`, or null when
 * there is no assignment between them.
 */
export async function getAssistantCapabilities(
  assistantId: string,
  principalId: string,
  organizationId: string
): Promise<AssistantCapabilities | null> {
  if (!assistantId || !principalId || !organizationId) return null;
  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('can_file, can_upload, can_edit, can_withdraw, can_manage_notifications, can_gatekeep')
    .eq('organization_id', organizationId)
    .eq('assistant_id', assistantId)
    .eq('principal_id', principalId)
    .maybeSingle();

  if (error || !data) return null;
  return data as AssistantCapabilities;
}

/** The subject(s) a request is "owned" by for capability purposes. */
function requestSubjects(request: {
  creator_id?: string | null;
  metadata?: any;
}): string[] {
  const subjects = new Set<string>();
  if (request.creator_id) subjects.add(request.creator_id);
  const principalId = request.metadata?.onBehalfOf?.userId;
  if (principalId) subjects.add(principalId);
  return Array.from(subjects);
}

/**
 * Whether `userId` may perform `capability` on `request` by virtue of being an
 * assistant (with that capability) of the request's creator OR of the person it
 * was filed on behalf of. Used by the upload / edit / withdraw gates.
 *
 * Note: when the assistant filed the request themselves they are already the
 * `creator_id` and pass the gate's own creator check — this covers acting on a
 * principal's OTHER requests.
 */
export async function assistantCanActOn(
  userId: string,
  organizationId: string,
  request: { creator_id?: string | null; organization_id?: string | null; metadata?: any },
  capability: AssistantCapability
): Promise<boolean> {
  if (!userId || !organizationId) return false;
  const orgId = organizationId || request.organization_id || '';
  if (!orgId) return false;

  const subjects = requestSubjects(request).filter((s) => s !== userId);
  if (subjects.length === 0) return false;

  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('principal_id')
    .eq('organization_id', orgId)
    .eq('assistant_id', userId)
    .in('principal_id', subjects)
    .eq(capability, true)
    .limit(1);

  if (error) {
    console.error('assistantCanActOn query failed:', error);
    return false;
  }
  return (data?.length || 0) > 0;
}

/**
 * The assistants who should receive a COPY of a notification addressed to
 * `principalId` — i.e. those with `can_manage_notifications`. Returns their
 * user ids (excluding the principal). Used by the notification fan-out.
 */
export async function getNotificationAssistants(
  principalId: string,
  organizationId: string
): Promise<string[]> {
  if (!principalId || !organizationId) return [];
  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('assistant_id')
    .eq('organization_id', organizationId)
    .eq('principal_id', principalId)
    .eq('can_manage_notifications', true);

  if (error) {
    console.error('getNotificationAssistants failed:', error);
    return [];
  }
  return (data || [])
    .map((r: any) => r.assistant_id)
    .filter((id: string) => id && id !== principalId);
}

export interface FanoutPayload {
  type: string;
  title: string;
  message: string;
  senderId?: string | null;
  metadata?: Record<string, any>;
}

/**
 * Deliver a COPY of a notification addressed to `principalId` to each of their
 * `can_manage_notifications` assistants. Each copy is a separate `notifications`
 * row (independent read/delete state), tagged `on_behalf_of` in metadata and
 * prefixed so the assistant sees whose notification it is. Best-effort — never
 * throws (callers are inside notification side-effects).
 */
export async function fanoutToNotificationAssistants(
  principalId: string,
  organizationId: string,
  payload: FanoutPayload
): Promise<void> {
  try {
    const assistantIds = await getNotificationAssistants(principalId, organizationId);
    if (assistantIds.length === 0) return;

    // Resolve the principal's name once for the copy's title.
    const { data: principal } = await supabaseAdmin
      .from('app_users')
      .select('display_name, email')
      .eq('id', principalId)
      .maybeSingle();
    const principalName = principal?.display_name || principal?.email || 'the person you assist';

    const rows = assistantIds.map((assistantId) => ({
      organization_id: organizationId,
      recipient_id: assistantId,
      sender_id: payload.senderId || null,
      type: payload.type,
      title: `For ${principalName}: ${payload.title}`,
      message: payload.message,
      metadata: {
        ...(payload.metadata || {}),
        on_behalf_of: principalId,
        notification_copy: true,
      },
      is_read: false,
    }));

    await supabaseAdmin.from('notifications').insert(rows);
  } catch (error) {
    console.error('fanoutToNotificationAssistants failed:', error);
  }
}

// ============================================================================
// Gatekeeping — screen a principal's approvals before they reach the principal
// ============================================================================

/**
 * The assistants who SCREEN `principalId`'s incoming approvals (can_gatekeep =
 * true) — i.e. they receive the approval notification/email first and decide
 * whether it goes forward to the boss or back to the requestor. Returns their
 * user ids (excluding the principal). Returns [] (never throws).
 */
export async function getGatekeepersFor(
  principalId: string,
  organizationId: string
): Promise<string[]> {
  if (!principalId || !organizationId) return [];
  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('assistant_id')
    .eq('organization_id', organizationId)
    .eq('principal_id', principalId)
    .eq('can_gatekeep', true);

  if (error) {
    console.error('getGatekeepersFor failed:', error);
    return [];
  }
  return (data || [])
    .map((r: any) => r.assistant_id)
    .filter((id: string) => id && id !== principalId);
}

/** Whether `assistantId` gatekeeps `principalId`'s approvals (can_gatekeep = true). */
export async function isGatekeeperFor(
  assistantId: string,
  principalId: string,
  organizationId: string
): Promise<boolean> {
  if (!assistantId || !principalId || !organizationId) return false;
  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('assistant_id', assistantId)
    .eq('principal_id', principalId)
    .eq('can_gatekeep', true)
    .limit(1);

  if (error) {
    console.error('isGatekeeperFor query failed:', error);
    return false;
  }
  return (data?.length || 0) > 0;
}

/**
 * The principals whose approvals `assistantId` screens (can_gatekeep = true),
 * mapped to app_users for display. Mirrors getPrincipalsForAssistant. Returns
 * [] (never throws). Used by the screening queue.
 */
export async function getGatekeptPrincipals(
  assistantId: string,
  organizationId: string
): Promise<AssignedPrincipal[]> {
  if (!assistantId || !organizationId) return [];

  const { data, error } = await supabaseAdmin
    .from('assistant_assignments')
    .select('principal:app_users!assistant_assignments_principal_id_fkey ( id, display_name, email, job_title )')
    .eq('organization_id', organizationId)
    .eq('assistant_id', assistantId)
    .eq('can_gatekeep', true);

  if (error) {
    console.error('getGatekeptPrincipals failed:', error);
    return [];
  }

  return (data || [])
    .map((row: any) => row.principal)
    .filter(Boolean)
    .map((p: any) => ({
      userId: p.id,
      name: p.display_name || p.email,
      email: p.email,
      positionTitle: p.job_title || '',
    }));
}
