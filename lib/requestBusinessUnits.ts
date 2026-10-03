import { supabaseAdmin } from './supabaseAdmin';
import { fetchHrimsBusinessUnits } from './hrimsClient';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from './rbac';

/**
 * Business units a user may file requests for, beyond their HRIMS home unit.
 *
 * HRIMS records one business unit per employee. Staff who work across several
 * hold `requests.multi_business_unit` (the "Multi-Unit Requester" role) and an
 * admin ticks their extra units in the User Access Manager
 * (user_request_business_units, keyed by HRIMS business-unit code). The home
 * unit is always available on top of these.
 *
 * Without the permission the stored list is ignored, so revoking the role is
 * enough to switch the picker off.
 */

export interface RequestBusinessUnit {
  /** HRIMS business_units.id in this environment (null if the code no longer resolves). */
  id: string | null;
  code: string;
  name: string;
}

/** Units ticked for the user (raw — no permission check). */
export async function getAssignedRequestBusinessUnits(userId: string): Promise<{ code: string; name: string }[]> {
  const { data } = await supabaseAdmin
    .from('user_request_business_units')
    .select('business_unit_code, business_unit_name')
    .eq('user_id', userId)
    .order('business_unit_name', { ascending: true });
  return (data || []).map((r: any) => ({ code: r.business_unit_code, name: r.business_unit_name }));
}

/**
 * Units the user may file for, or [] when they don't hold the permission.
 * Codes are resolved against HRIMS so callers get the current id and name.
 */
export async function getRequestBusinessUnits(userId: string): Promise<RequestBusinessUnit[]> {
  if (!userId) return [];
  try {
    const profile = await getUserRBACProfile(userId);
    if (!hasPermission(profile, PERMISSIONS.REQUESTS_MULTI_BUSINESS_UNIT)) return [];

    const assigned = await getAssignedRequestBusinessUnits(userId);
    if (assigned.length === 0) return [];

    let hrimsUnits: { id: string; code: string; name: string }[] = [];
    try {
      hrimsUnits = await fetchHrimsBusinessUnits();
    } catch (err) {
      console.error('getRequestBusinessUnits: HRIMS lookup failed', err);
    }

    return assigned.map((a) => {
      const hit = hrimsUnits.find((u) => (u.code || '').toUpperCase() === a.code.toUpperCase());
      return { id: hit?.id || null, code: a.code, name: hit?.name || a.name };
    });
  } catch (err) {
    console.error('getRequestBusinessUnits failed:', err);
    return [];
  }
}

/** Whether the user (by email, within the org) may file for the given HRIMS unit code. */
export async function canFileForBusinessUnit(
  email: string,
  organizationId: string,
  code: string | null | undefined,
): Promise<boolean> {
  if (!email || !code) return false;
  const { data: appUser } = await supabaseAdmin
    .from('app_users')
    .select('id')
    .eq('organization_id', organizationId)
    .ilike('email', email)
    .limit(1)
    .maybeSingle();
  if (!appUser) return false;
  const units = await getRequestBusinessUnits(appUser.id);
  return units.some((u) => u.code.toUpperCase() === code.toUpperCase());
}
