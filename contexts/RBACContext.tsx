import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';

// ============================================================
// Types
// ============================================================

interface Permission {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
}

interface RoleWithPermissions {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  is_system: boolean;
  is_default: boolean;
  priority: number;
  permissions: Permission[];
}

interface UserRole {
  id: string;
  user_id: string;
  role_id: string;
  department_id: string | null;
  business_unit_id: string | null;
  assigned_by: string | null;
  assigned_at: string;
  expires_at: string | null;
  is_active: boolean;
}

interface RBACProfile {
  roles: RoleWithPermissions[];
  permissions: string[];
  scoped_roles: UserRole[];
  is_super_admin: boolean;
}

interface RBACContextType {
  rbac: RBACProfile | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  hasPermission: (code: string) => boolean;
  hasAnyPermission: (codes: string[]) => boolean;
  hasAllPermissions: (codes: string[]) => boolean;
  hasRole: (slug: string) => boolean;
  isSuperAdmin: boolean;
  isSystemAdmin: boolean;
  isAuditor: boolean;
}

const RBACContext = createContext<RBACContextType | undefined>(undefined);

// ============================================================
// Provider
// ============================================================

const RBAC_CACHE_KEY = 'the_circle_rbac_profile';

function getCachedRBAC(userId: string): RBACProfile | null {
  try {
    const raw = sessionStorage.getItem(RBAC_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (cached._userId === userId) return cached.profile;
    return null;
  } catch {
    return null;
  }
}

function setCachedRBAC(userId: string, profile: RBACProfile) {
  try {
    sessionStorage.setItem(RBAC_CACHE_KEY, JSON.stringify({ _userId: userId, profile }));
  } catch {
    // sessionStorage may be unavailable
  }
}

function clearCachedRBAC() {
  try {
    sessionStorage.removeItem(RBAC_CACHE_KEY);
  } catch {
    // ignore
  }
}

export function RBACProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const [rbac, setRbac] = useState<RBACProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // The user id we have a profile loaded/loading for. Keyed by user (NOT a
  // one-shot boolean) so we (re)fetch whenever the signed-in user settles or
  // changes — crucial right after login, where session.user.id can arrive a
  // tick AFTER status flips to 'authenticated'. A one-shot guard would fetch
  // once with a not-yet-ready id and never recover without a page refresh.
  const loadedForUserRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionUserId = session?.user?.id as string | undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const fetchRBAC = useCallback(async (userId: string) => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }

    // Only show the spinner when we have nothing cached for this user.
    const cached = getCachedRBAC(userId);
    if (cached) { setRbac(cached); setLoading(false); } else { setLoading(true); }

    // The profile fetch hits Supabase, which occasionally drops a keep-alive
    // socket (UND_ERR_SOCKET) and returns a transient failure. A single miss
    // would leave the user apparently role-less ("empty sidenav"), so retry a
    // few times with backoff, then — if still failing — schedule a background
    // retry so the app self-heals WITHOUT the user needing to refresh.
    const MAX_ATTEMPTS = 4;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch('/api/rbac/profile');
        if (!response.ok) throw new Error(`Failed to fetch RBAC profile (${response.status})`);
        const data = await response.json();
        if (!mountedRef.current) return;
        setRbac(data);
        setCachedRBAC(userId, data);
        setError(null);
        setLoading(false);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 400));
      }
    }

    if (!mountedRef.current) return;
    console.error('Error in RBACContext (after retries):', lastErr);
    setError(lastErr as Error);
    setLoading(false);
    // Allow this user to be re-fetched, and self-heal on a timer.
    loadedForUserRef.current = null;
    retryTimerRef.current = setTimeout(() => {
      if (mountedRef.current && sessionUserId) { loadedForUserRef.current = sessionUserId; fetchRBAC(sessionUserId); }
    }, 5000);
  }, [sessionUserId]);

  // (Re)load the profile whenever the signed-in user settles or changes.
  useEffect(() => {
    if (status === 'loading') return;                 // wait for the session to resolve
    if (!sessionUserId) {                              // signed out
      loadedForUserRef.current = null;
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      setRbac(null);
      setLoading(false);
      setError(null);
      clearCachedRBAC();
      return;
    }
    if (loadedForUserRef.current === sessionUserId) return; // already have / fetching this user
    loadedForUserRef.current = sessionUserId;
    const cached = getCachedRBAC(sessionUserId);       // restore cache immediately to avoid a flash
    if (cached) setRbac(cached);
    fetchRBAC(sessionUserId);
  }, [sessionUserId, status, fetchRBAC]);

  const refetch = useCallback(async () => {
    if (sessionUserId) { loadedForUserRef.current = sessionUserId; await fetchRBAC(sessionUserId); }
  }, [sessionUserId, fetchRBAC]);

  const hasPermission = useCallback((code: string): boolean => {
    if (!rbac) return false;
    if (rbac.is_super_admin) return true;
    return rbac.permissions.includes(code);
  }, [rbac]);

  const hasAnyPermission = useCallback((codes: string[]): boolean => {
    if (!rbac) return false;
    if (rbac.is_super_admin) return true;
    return codes.some(code => rbac.permissions.includes(code));
  }, [rbac]);

  const hasAllPermissions = useCallback((codes: string[]): boolean => {
    if (!rbac) return false;
    if (rbac.is_super_admin) return true;
    return codes.every(code => rbac.permissions.includes(code));
  }, [rbac]);

  const hasRole = useCallback((slug: string): boolean => {
    if (!rbac) return false;
    return rbac.roles.some(r => r.slug === slug);
  }, [rbac]);

  const isSuperAdmin = rbac?.is_super_admin || false;
  const isSystemAdmin = rbac?.roles.some(r => r.slug === 'system_admin') || false;
  const isAuditor = rbac?.roles.some(r => r.slug === 'auditor') || false;

  return (
    <RBACContext.Provider value={{
      rbac,
      loading,
      error,
      refetch,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      hasRole,
      isSuperAdmin,
      isSystemAdmin,
      isAuditor,
    }}>
      {children}
    </RBACContext.Provider>
  );
}

// ============================================================
// Hook
// ============================================================

export function useRBAC() {
  const context = useContext(RBACContext);
  if (context === undefined) {
    throw new Error('useRBAC must be used within an RBACProvider');
  }
  return context;
}

/**
 * Client-side page gate. Redirects to `redirectTo` once the RBAC profile has
 * loaded and the user has none of `codes`. Uses the cached RBAC profile, so an
 * authorised user never sees a flash — this lets pages skip an expensive
 * server-side permission query in getServerSideProps.
 */
export function useRequirePermission(codes: string[], redirectTo = '/dashboard') {
  const { hasAnyPermission, loading, rbac } = useRBAC();
  const router = useRouter();
  const key = codes.join(',');
  useEffect(() => {
    if (loading || !rbac) return;
    if (!hasAnyPermission(codes)) router.replace(redirectTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rbac, key, redirectTo]);
}
