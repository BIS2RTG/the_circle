import { supabaseAdmin } from './supabaseAdmin';
import { canFileOnBehalfOf } from './assistantAssignments';
import { fetchHrimsDepartmentById, fetchHrimsBusinessUnitById } from './hrimsClient';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from './rbac';

/**
 * "File on behalf of" server-side guard.
 *
 * Two routes grant the right to name someone else as the beneficiary:
 *
 *   1. Assistants — a systems admin assigned them to that specific person
 *      (`assistant_assignments`, can_file).
 *   2. HR admins — anyone holding `requests.file_on_behalf_any` may file for
 *      ANY employee in the organization, and for guests who have no account
 *      here at all (external beneficiaries).
 *
 * The filer always remains the filer of record; the beneficiary is stored on
 * `metadata.onBehalfOf`.
 *
 * The client sends `metadata.onBehalfOf`, but it is never trusted — this
 * re-derives the relationship and re-reads the display fields server-side.
 */

export interface OnBehalfOf {
  /** app_users id. Absent for an external beneficiary. */
  userId?: string;
  name?: string;
  positionTitle?: string;
  email?: string;
  /**
   * True when the beneficiary is not part of the organization and so has no
   * account. `userId` is absent and `name` carries the whole identity.
   */
  external?: boolean;
  /** Organization the external beneficiary belongs to, if given. */
  company?: string;
}

/**
 * Whether a request was filed for someone other than the filer. Prefer this to
 * checking `onBehalfOf.userId`, which is absent for external beneficiaries.
 */
export function isOnBehalf(onBehalfOf: any): boolean {
  if (!onBehalfOf || typeof onBehalfOf !== 'object') return false;
  return Boolean(onBehalfOf.userId) || (onBehalfOf.external === true && Boolean(onBehalfOf.name));
}

/** Whether `userId` may file on behalf of anyone (the HR-admin route). */
export async function canFileOnBehalfOfAnyone(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const profile = await getUserRBACProfile(userId);
    return hasPermission(profile, PERMISSIONS.REQUESTS_FILE_ON_BEHALF_ANY);
  } catch (error) {
    console.error('canFileOnBehalfOfAnyone failed:', error);
    return false;
  }
}

export interface OnBehalfResult {
  ok: boolean;
  error?: string;
  /** Server-verified, normalised value to persist (undefined when none). */
  normalized?: OnBehalfOf;
}

/** Creator-shaped profile of the person a request was filed on behalf of. */
export interface OnBehalfProfile {
  /** app_users id, or '' for an external beneficiary who has no account. */
  id: string;
  display_name: string | null;
  email: string | null;
  job_title: string | null;
  department?: { id: string; name: string } | null;
  business_unit?: { id: string; name: string } | null;
  /** True when this person is not part of the organization. */
  external?: boolean;
}

/**
 * Resolve the "on behalf of" principal into a creator-shaped profile (name,
 * email, job title, department + business-unit names) so previews and the PDF
 * can present THEM as the requestor — not the assistant who filed. Returns null
 * when the request wasn't filed on behalf of anyone. Best-effort on HRIMS names.
 */
export async function resolveOnBehalfProfile(
  request: { metadata?: any } | null | undefined
): Promise<OnBehalfProfile | null> {
  const ob = request?.metadata?.onBehalfOf;
  if (!isOnBehalf(ob)) return null;

  // External guests have no account to read — the request itself is the only
  // record of who they are.
  if (!ob.userId) {
    return {
      id: '',
      display_name: ob.name || null,
      email: ob.email || null,
      job_title: ob.company ? `External — ${ob.company}` : 'External guest',
      external: true,
    };
  }

  const { data: principal } = await supabaseAdmin
    .from('app_users')
    .select('id, display_name, email, job_title, department_id, business_unit_id')
    .eq('id', ob.userId)
    .maybeSingle();

  if (!principal) {
    // The row is gone — fall back to whatever was stored on the request.
    return {
      id: ob.userId,
      display_name: ob.name || null,
      email: ob.email || null,
      job_title: ob.positionTitle || null,
    };
  }

  const profile: OnBehalfProfile = {
    id: principal.id,
    display_name: principal.display_name || ob.name || null,
    email: principal.email || ob.email || null,
    job_title: principal.job_title || ob.positionTitle || null,
  };

  // Department / business-unit names live in HRIMS (separate project).
  try {
    const [dept, bu] = await Promise.all([
      principal.department_id ? fetchHrimsDepartmentById(principal.department_id) : Promise.resolve(null),
      principal.business_unit_id ? fetchHrimsBusinessUnitById(principal.business_unit_id) : Promise.resolve(null),
    ]);
    if (dept) profile.department = { id: dept.id, name: dept.name };
    if (bu) profile.business_unit = { id: bu.id, name: bu.name };
  } catch {
    /* HRIMS unavailable — names stay undefined */
  }

  return profile;
}

/**
 * Validate an incoming `onBehalfOf` beneficiary. Returns `{ ok: true }` with no
 * `normalized` value when the request isn't on-behalf-of anyone.
 */
export async function assertValidOnBehalf(
  organizationId: string,
  filerUserId: string,
  onBehalfOf: any
): Promise<OnBehalfResult> {
  if (!onBehalfOf || typeof onBehalfOf !== 'object') {
    return { ok: true };
  }

  // ---- External beneficiary (no account here) ----------------------------
  // Only the HR-admin right can name one; assistants are scoped to the
  // specific people they were assigned to, all of whom have accounts.
  if (!onBehalfOf.userId) {
    if (onBehalfOf.external !== true) return { ok: true };

    const name = typeof onBehalfOf.name === 'string' ? onBehalfOf.name.trim() : '';
    if (!name) {
      return { ok: false, error: 'Enter the name of the person you are filing for.' };
    }

    if (!(await canFileOnBehalfOfAnyone(filerUserId))) {
      return {
        ok: false,
        error: 'You do not have permission to file on behalf of someone outside the organization.',
      };
    }

    const email = typeof onBehalfOf.email === 'string' ? onBehalfOf.email.trim() : '';
    const company = typeof onBehalfOf.company === 'string' ? onBehalfOf.company.trim() : '';
    return {
      ok: true,
      normalized: {
        external: true,
        name,
        email: email || undefined,
        company: company || undefined,
      },
    };
  }

  const beneficiaryId: string = onBehalfOf.userId;

  if (beneficiaryId === filerUserId) {
    // Filing "on behalf of" yourself is meaningless — just drop it.
    return { ok: true };
  }

  // ---- Internal beneficiary: assistant assignment OR the HR-admin right ---
  const allowed =
    (await canFileOnBehalfOf(filerUserId, beneficiaryId, organizationId)) ||
    (await canFileOnBehalfOfAnyone(filerUserId));
  if (!allowed) {
    return {
      ok: false,
      error: 'You are not assigned as an assistant for this person, so you cannot file on their behalf.',
    };
  }

  // Re-derive the display fields from app_users rather than trusting the client.
  const { data: principal } = await supabaseAdmin
    .from('app_users')
    .select('id, display_name, email, job_title')
    .eq('id', beneficiaryId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (!principal) {
    return { ok: false, error: 'That person was not found in your organization.' };
  }

  return {
    ok: true,
    normalized: {
      userId: principal.id,
      name: principal.display_name || principal.email,
      positionTitle: principal.job_title || undefined,
      email: principal.email,
    },
  };
}
