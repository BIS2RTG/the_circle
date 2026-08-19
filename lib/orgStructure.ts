/**
 * Organisation structure (business units + departments) with a local fallback.
 *
 * The live source of truth is HRIMS (see hrimsClient). But some deployments —
 * notably the legal/staging environments — deliberately do NOT connect to live
 * HRIMS (to avoid exposing real HR data). For those, we fall back to fake data
 * seeded in the Circle DB's own `business_units` / `departments` tables.
 *
 * The fallback triggers only when HRIMS is unconfigured, errors, or returns an
 * empty set — so production (with HRIMS configured and populated) is unaffected.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { hrimsClient, fetchHrimsBusinessUnits, fetchHrimsDepartments } from './hrimsClient';

export interface OrgBusinessUnit {
  id: string;
  name: string;
  code: string | null;
}

export interface OrgDepartment {
  id: string;
  name: string;
  code: string | null;
  business_unit_id: string | null;
}

/** Business units from HRIMS, falling back to the Circle DB's local table. */
export async function getBusinessUnits(orgId?: string): Promise<OrgBusinessUnit[]> {
  if (hrimsClient) {
    try {
      const hb = await fetchHrimsBusinessUnits();
      if (hb && hb.length > 0) {
        return hb.map((u) => ({ id: u.id, name: u.name, code: u.code ?? null }));
      }
    } catch {
      /* HRIMS unavailable — fall through to the local table */
    }
  }

  let query = supabaseAdmin.from('business_units').select('id, name').order('name', { ascending: true });
  if (orgId) query = query.eq('organization_id', orgId);
  const { data } = await query;
  return (data || []).map((u: any) => ({ id: u.id, name: u.name, code: null }));
}

/** Departments from HRIMS, falling back to the Circle DB's local table. */
export async function getDepartments(
  orgId?: string,
  businessUnitId?: string
): Promise<OrgDepartment[]> {
  if (hrimsClient) {
    try {
      const hd = await fetchHrimsDepartments(businessUnitId);
      if (hd && hd.length > 0) {
        return hd.map((d) => ({
          id: d.id,
          name: d.name,
          code: d.code ?? null,
          business_unit_id: d.business_unit_id ?? null,
        }));
      }
    } catch {
      /* HRIMS unavailable — fall through to the local table */
    }
  }

  // The local `departments` table is not scoped to a business unit, so the
  // businessUnitId filter is intentionally ignored here (fake data is org-wide).
  let query = supabaseAdmin.from('departments').select('id, name, code').order('name', { ascending: true });
  if (orgId) query = query.eq('organization_id', orgId);
  const { data } = await query;
  return (data || []).map((d: any) => ({ id: d.id, name: d.name, code: d.code ?? null, business_unit_id: null }));
}
