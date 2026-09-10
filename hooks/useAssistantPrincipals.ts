import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

export interface AssignedPrincipal {
  userId: string;
  name: string;
  positionTitle: string;
  email: string;
}

/**
 * Session-scoped cache so the on-behalf list is fetched once, not on every
 * form navigation. The list changes rarely (only when an admin edits
 * assignments), so a short TTL is plenty and keeps the field instant across
 * forms within a session.
 */
export interface OnBehalfScope {
  principals: AssignedPrincipal[];
  /** HR-admin right: search the whole directory and name external guests. */
  canFileForAnyone: boolean;
}

const EMPTY_SCOPE: OnBehalfScope = { principals: [], canFileForAnyone: false };

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; scope: OnBehalfScope } | null = null;
let inflight: Promise<OnBehalfScope> | null = null;

function loadPrincipals(): Promise<OnBehalfScope> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.scope);
  if (inflight) return inflight;
  inflight = fetch('/api/user/assistant-principals')
    .then((res) => (res.ok ? res.json() : EMPTY_SCOPE))
    .then((data) => {
      const scope: OnBehalfScope = {
        principals: data.principals || [],
        canFileForAnyone: data.canFileForAnyone === true,
      };
      cache = { at: Date.now(), scope };
      return scope;
    })
    .catch(() => EMPTY_SCOPE)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Clear the cache (e.g. after an admin changes assignments). */
export function invalidateAssistantPrincipals() {
  cache = null;
}

/**
 * Who the current user may file requests on behalf of: their assigned
 * principals, plus whether they hold the HR-admin right to file for anyone
 * (including external guests). An empty list and no right means the on-behalf
 * field hides itself. Backed by a session cache so it's instant after the
 * first form.
 */
export function useAssistantPrincipals() {
  const { status } = useSession();
  // Seed synchronously from cache so a warm field renders on first paint.
  const [scope, setScope] = useState<OnBehalfScope>(() => cache?.scope ?? EMPTY_SCOPE);
  const [loading, setLoading] = useState(() => !cache);

  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;
    loadPrincipals().then((next) => {
      if (!cancelled) {
        setScope(next);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  return { principals: scope.principals, canFileForAnyone: scope.canFileForAnyone, loading };
}
