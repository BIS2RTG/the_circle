/**
 * Server-only helpers for the BGM API routes: session + RBAC permission gate,
 * plus resolution of the caller's organization. Keeps every route's auth
 * preamble to a single call.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../pages/api/auth/[...nextauth]';
import { getUserRBACProfile, hasAnyPermission } from './rbac';

export interface BgmContext {
  userId: string;
  organizationId: string;
  displayName: string | null;
  email: string | null;
}

/**
 * Guard a BGM API handler. Returns the context on success, or writes an
 * error response and returns null (caller should `return`).
 */
export async function requireBgm(
  req: NextApiRequest,
  res: NextApiResponse,
  permissions: string[]
): Promise<BgmContext | null> {
  const session = await getServerSession(req, res, authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  const profile = await getUserRBACProfile(userId);
  if (permissions.length > 0 && !hasAnyPermission(profile, permissions)) {
    res.status(403).json({ error: 'You do not have permission to perform this action.' });
    return null;
  }

  return {
    userId,
    organizationId: (session!.user as any).org_id,
    displayName: session!.user?.name ?? null,
    email: session!.user?.email ?? null,
  };
}
