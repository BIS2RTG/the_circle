import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';

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
  const hasFetchedRef = useRef(false);

  const sessionUserId = session?.user?.id;

  // On mount / user change, immediately restore cached RBAC to prevent flash
  useEffect(() => {
    if (status === 'loading') return;
    if (!sessionUserId) {
      setRbac(null);
      setLoading(false);
      clearCachedRBAC();
      return;
    }
    const cached = getCachedRBAC(sessionUserId);
    if (cached) {
      setRbac(cached);
      setLoading(false);
    }
  }, [sessionUserId, status]);

  const fetchRBAC = useCallback(async () => {
    if (status === 'loading') return;

    if (!sessionUserId) {
      setRbac(null);
      setLoading(false);
      clearCachedRBAC();
      return;
    }

    // Only show loading spinner if we have no cached data
    const cached = getCachedRBAC(sessionUserId);
    if (!cached) {
      setLoading(true);
    }

    // The profile fetch hits Supabase server-side, which occasionally drops a
    // keep-alive socket (UND_ERR_SOCKET) and returns a transient failure. A
    // single miss here would leave the user apparently role-less ("No roles"),
    // so retry a few times with a short backoff before giving up. On total
    // failure we keep any cached profile rather than clobbering it with null.
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch('/api/rbac/profile');
        if (!response.ok) {
          throw new Error(`Failed to fetch RBAC profile (${response.status})`);
        }
        const data = await response.json();
        setRbac(data);
        setCachedRBAC(sessionUserId, data);
        setError(null);
        setLoading(false);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, attempt * 400));
        }
      }
    }

    console.error('Error in RBACContext (after retries):', lastErr);
    setError(lastErr as Error);
    setLoading(false);
  }, [sessionUserId, status]);

  useEffect(() => {
    if (status === 'loading') return;
    if (hasFetchedRef.current) return;

    fetchRBAC();
    hasFetchedRef.current = true;
  }, [fetchRBAC, status]);

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
      refetch: fetchRBAC,
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
