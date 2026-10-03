import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';

interface HrimsUserProfile {
  employee: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    job_title: string | null;
    department_id: string | null;
    business_unit_id: string;
  } | null;
  department: {
    id: string;
    name: string;
    code: string;
  } | null;
  businessUnit: {
    id: string;
    name: string;
    code: string;
  } | null;
  position: {
    id: string;
    position_title: string;
    grade: string | null;
    level: number;
  } | null;
  /** Immediate manager from the organogram — null for top positions (e.g. CEO). */
  reportsTo: {
    name: string;
    email: string | null;
    jobTitle: string | null;
  } | null;
  found: boolean;
}

const CACHE_PREFIX = 'hrims:profile:';
/** Cache freshness window — older entries are still served as a fallback when the
 *  network is unreachable, but a refresh attempt happens in the background. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedEntry {
  profile: HrimsUserProfile;
  cachedAt: number;
}

function readCache(email: string): CachedEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + email);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry;
    if (!parsed || typeof parsed.cachedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(email: string, profile: HrimsUserProfile) {
  if (typeof window === 'undefined') return;
  try {
    const entry: CachedEntry = { profile, cachedAt: Date.now() };
    window.localStorage.setItem(CACHE_PREFIX + email, JSON.stringify(entry));
  } catch {
    /* storage quota / private mode — caching is best-effort */
  }
}

// ---- Multi-business-unit selection ----------------------------------------
// Multi-Unit Requesters (lib/requestBusinessUnits) pick which unit they're
// filing for: their HRIMS home unit plus the units an admin ticked for them.
// The choice is shared by every hook instance on the page (so the form, its
// requestor block and approver resolution all agree) and remembered per browser.

export interface BusinessUnitOption {
  id: string;
  name: string;
  code: string;
}

const BU_SELECTION_PREFIX = 'hrims:selected-bu:';
const buListeners = new Set<() => void>();
let assignedUnitsCache: { email: string; units: BusinessUnitOption[] } | null = null;
let assignedUnitsInflight: { email: string; promise: Promise<BusinessUnitOption[]> } | null = null;

function readSelectedBu(email: string): string | null {
  if (typeof window === 'undefined' || !email) return null;
  try { return window.localStorage.getItem(BU_SELECTION_PREFIX + email.toLowerCase()); } catch { return null; }
}

function writeSelectedBu(email: string, code: string) {
  try { window.localStorage.setItem(BU_SELECTION_PREFIX + email.toLowerCase(), code); } catch { /* best-effort */ }
  buListeners.forEach((fn) => fn());
}

/** Extra units assigned to the signed-in user ([] unless they're a Multi-Unit Requester). */
async function loadAssignedUnits(email: string): Promise<BusinessUnitOption[]> {
  if (assignedUnitsCache?.email === email) return assignedUnitsCache.units;
  if (assignedUnitsInflight?.email !== email) {
    const promise = fetch('/api/rbac/request-units')
      .then((r) => (r.ok ? r.json() : { units: [] }))
      .then((data) => {
        const units: BusinessUnitOption[] = (data?.units || [])
          .filter((u: any) => u?.id && u?.code)
          .map((u: any) => ({ id: u.id, name: u.name, code: u.code }));
        assignedUnitsCache = { email, units };
        return units;
      })
      .catch(() => [] as BusinessUnitOption[])
      .finally(() => { assignedUnitsInflight = null; });
    assignedUnitsInflight = { email, promise };
  }
  return assignedUnitsInflight!.promise;
}

export function useUserHrimsProfile() {
  const { data: session } = useSession();
  const [profile, setProfile] = useState<HrimsUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  /** True when the profile we're showing came from the local cache because the
   *  HRIMS API was unreachable. Surfaces a "showing cached data" UI hint. */
  const [usingCache, setUsingCache] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchProfile() {
      const email = session?.user?.email;
      if (!email) {
        setLoading(false);
        return;
      }

      // Prime the UI from cache immediately so the form doesn't flash N/A
      // while the network request is in-flight, AND to keep the user
      // productive when HRIMS is unreachable.
      const cached = readCache(email);
      if (cached) {
        setProfile(cached.profile);
        setUsingCache(true);
        setLoading(false);
      } else {
        setLoading(true);
      }

      try {
        const response = await fetch(`/api/hrims/employee-by-email?email=${encodeURIComponent(email)}`);
        const data = await response.json().catch(() => ({}));

        if (cancelled) return;

        if (response.ok && data.found) {
          const fresh: HrimsUserProfile = {
            employee: data.employee,
            department: data.department,
            businessUnit: data.businessUnit,
            position: data.position,
            reportsTo: data.reportsTo || null,
            found: true,
          };
          setProfile(fresh);
          setUsingCache(false);
          setError(null);
          writeCache(email, fresh);
        } else if (response.status === 404 || (response.ok && data.found === false)) {
          // Authoritative "user not in HRIMS" — this is a SUCCESSFUL response,
          // not a network failure. Don't fall back to cache and don't surface
          // an "unreachable" banner. The API may still return details the user
          // saved on their Circle profile (source: 'circle'), so use those for
          // autofill rather than showing N/A everywhere.
          const circle: HrimsUserProfile = {
            employee: data.employee || null,
            department: data.department || null,
            businessUnit: data.businessUnit || null,
            position: data.position || null,
            reportsTo: data.reportsTo || null,
            found: false,
          };
          setProfile(circle);
          setUsingCache(false);
          setError(null);
          writeCache(email, circle);
        } else {
          // 5xx / network glitch — keep whatever cache we have on screen.
          throw new Error(data?.error || `HRIMS responded ${response.status}`);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Error fetching HRIMS profile:', err);
        setError(err as Error);
        if (!cached) {
          setProfile({
            employee: null,
            department: null,
            businessUnit: null,
            position: null,
            reportsTo: null,
            found: false,
          });
        }
        // If we did have cached data, leave it on screen — usingCache stays true.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchProfile();
    return () => { cancelled = true; };
  }, [session?.user?.email]);

  // Multi-Unit Requesters: load their assigned units and track the chosen one.
  const email = session?.user?.email || '';
  const [assignedUnits, setAssignedUnits] = useState<BusinessUnitOption[]>([]);
  const [selectedBuCode, setSelectedBuCode] = useState<string | null>(null);

  useEffect(() => {
    if (!email) { setAssignedUnits([]); return; }
    let cancelled = false;
    loadAssignedUnits(email).then((units) => { if (!cancelled) setAssignedUnits(units); });
    const sync = () => setSelectedBuCode(readSelectedBu(email));
    sync();
    buListeners.add(sync);
    return () => { cancelled = true; buListeners.delete(sync); };
  }, [email]);

  // Home unit first, then the assigned extras (deduplicated by code).
  const homeUnit = profile?.businessUnit;
  const businessUnitOptions: BusinessUnitOption[] = assignedUnits.length === 0 ? [] : [
    ...(homeUnit?.id ? [{ id: homeUnit.id, name: homeUnit.name, code: homeUnit.code }] : []),
    ...assignedUnits.filter((u) => !homeUnit?.code || u.code.toUpperCase() !== homeUnit.code.toUpperCase()),
  ];
  const isMultiUnit = businessUnitOptions.length > 1;

  const setSelectedBusinessUnit = useCallback((code: string) => {
    if (email) writeSelectedBu(email, code);
  }, [email]);

  const selectedOption = isMultiUnit
    ? businessUnitOptions.find((o) => o.code.toUpperCase() === (selectedBuCode || '').toUpperCase())
    : undefined;

  // Overlay the selected unit onto the HRIMS profile so every consumer (names,
  // codes, ids used for department lookups) reflects the unit being filed for.
  const effectiveProfile: HrimsUserProfile | null = profile && selectedOption
    ? {
        ...profile,
        businessUnit: { id: selectedOption.id, name: selectedOption.name, code: selectedOption.code },
        employee: profile.employee ? { ...profile.employee, business_unit_id: selectedOption.id } : profile.employee,
      }
    : profile;

  const cached = readCache(email);
  const cacheAgeMs = cached ? Date.now() - cached.cachedAt : null;
  const cacheStale = cacheAgeMs != null && cacheAgeMs > CACHE_TTL_MS;

  return {
    profile: effectiveProfile,
    loading,
    error,
    usingCache,
    cacheStale,
    departmentName: effectiveProfile?.department?.name || null,
    businessUnitName: effectiveProfile?.businessUnit?.name || null,
    businessUnitCode: effectiveProfile?.businessUnit?.code || null,
    /** HRIMS id of the unit being filed for (the selected one for multi-unit users). */
    businessUnitId: effectiveProfile?.businessUnit?.id || effectiveProfile?.employee?.business_unit_id || null,
    jobTitle: effectiveProfile?.employee?.job_title || null,
    positionTitle: effectiveProfile?.position?.position_title || null,
    reportsTo: effectiveProfile?.reportsTo || null,
    /** Units a Multi-Unit Requester may file under ([] for everyone else). */
    businessUnitOptions: isMultiUnit ? businessUnitOptions : [],
    /** Choose which unit to file under (multi-unit users only). */
    setSelectedBusinessUnit,
  };
}
