import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useCurrentUser } from './useCurrentUser';
import { useUserHrimsProfile } from './useUserHrimsProfile';
import type { OnBehalfOf } from '../components/requests/OnBehalfOfField';

export interface RequestorIdentity {
  /** True when filing on behalf of a principal (someone other than the signed-in user). */
  isOnBehalf: boolean;
  name?: string;
  department?: string;
  businessUnit?: string;
  /** True while the requestor's department/business unit is still resolving. */
  loading: boolean;
}

/**
 * Resolve the requestor identity shown on a request form and its document.
 *
 * When filing on behalf of a principal, this resolves to the PRINCIPAL — the
 * name comes from the selection, and their department/business unit are fetched
 * from HRIMS by email — so the form (and every preview/PDF built from it) reads
 * as if they filled it themselves. When filing for oneself, it resolves to the
 * signed-in user's own HRIMS profile.
 *
 * Shared by the travel, hotel/comp and voucher forms so the on-behalf behaviour
 * stays identical across them.
 */
export function useRequestorIdentity(onBehalfOf: OnBehalfOf | null): RequestorIdentity {
  const { data: session } = useSession();
  const { user } = useCurrentUser();
  const { departmentName, businessUnitName, loading: hrimsLoading } = useUserHrimsProfile();

  const [profile, setProfile] = useState<{ department?: string; businessUnit?: string } | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    const email = onBehalfOf?.email;
    if (!email) { setProfile(null); setProfileLoading(false); return; }
    let cancelled = false;
    setProfileLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/hrims/employee-by-email?email=${encodeURIComponent(email)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setProfile({
          department: data?.department?.name || undefined,
          businessUnit: data?.businessUnit?.name || undefined,
        });
      } catch {
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [onBehalfOf?.email]);

  const isOnBehalf = !!onBehalfOf?.userId;
  return {
    isOnBehalf,
    name: isOnBehalf ? (onBehalfOf?.name || undefined) : (user?.display_name || session?.user?.name || undefined),
    department: isOnBehalf ? (profile?.department || undefined) : (departmentName || undefined),
    businessUnit: isOnBehalf ? (profile?.businessUnit || undefined) : (businessUnitName || undefined),
    loading: isOnBehalf ? profileLoading : hrimsLoading,
  };
}
