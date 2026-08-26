/**
 * API route auth & permission gate for Board Governance & Meeting Administration (BGM).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../pages/api/auth/[...nextauth]';
import { getUserRBACProfile, hasAnyPermission } from './rbac';

export interface BgmApiContext {
  userId: string;
  organizationId: string;
  displayName: string;
  email: string;
}

/**
 * Gate an API route handler for BGM requirements.
 * Verifies session and optional RBAC permissions. Responds 401/403 directly on failure.
 */
export async function requireBgm(
  req: NextApiRequest,
  res: NextApiResponse,
  permissions: string[] = []
): Promise<BgmApiContext | null> {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const userId = user.id as string;
  const organizationId = (user.org_id as string) || 'default';
  const displayName = (user.name || user.display_name || user.email || '') as string;
  const email = (user.email || '') as string;

  if (permissions.length > 0) {
    const profile = await getUserRBACProfile(userId);
    if (!hasAnyPermission(profile, permissions)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
  }

  return { userId, organizationId, displayName, email };
}
