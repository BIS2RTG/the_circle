import { supabaseAdmin } from './supabaseAdmin';
import { canFileOnBehalfOf } from './assistantAssignments';
import { fetchHrimsDepartmentById, fetchHrimsBusinessUnitById } from './hrimsClient';

/**
 * "File on behalf of" server-side guard.
 *
 * A user may submit a form naming another person as the beneficiary ONLY when a
 * systems admin has assigned them as that person's assistant
 * (`assistant_assignments`). The filer remains the filer of record; the
 * beneficiary is stored on `metadata.onBehalfOf`.
 *
 * The client sends `metadata.onBehalfOf`, but it is never trusted — this
 * re-derives the relationship from `assistant_assignments`.
 */

export interface OnBehalfOf {
  userId: string;
  name?: string;
  positionTitle?: string;
  email?: string;
}

export interface OnBehalfResult {
  ok: boolean;
  error?: string;
  /** Server-verified, normalised value to persist (undefined when none). */
  normalized?: OnBehalfOf;
}

/** Creator-shaped profile of the person a request was filed on behalf of. */
export interface OnBehalfProfile {
  id: string;
  display_name: string | null;
  email: string | null;
  job_title: string | null;
  department?: { id: string; name: string } | null;
  business_unit?: { id: string; name: string } | null;
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
  if (!ob || !ob.userId) return null;

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
  if (!onBehalfOf || typeof onBehalfOf !== 'object' || !onBehalfOf.userId) {
    return { ok: true };
  }

  const beneficiaryId: string = onBehalfOf.userId;

  if (beneficiaryId === filerUserId) {
    // Filing "on behalf of" yourself is meaningless — just drop it.
    return { ok: true };
  }

  const allowed = await canFileOnBehalfOf(filerUserId, beneficiaryId, organizationId);
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
