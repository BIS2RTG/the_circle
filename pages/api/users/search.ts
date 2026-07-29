import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isGraphDirectoryConfigured, searchDirectoryUsers } from '@/lib/graphDirectory';
import { getValidMsAccessToken } from '@/lib/msTokenStore';

/**
 * User picker search for approvers / watchers.
 *
 * Source is controlled by USER_DIRECTORY_SOURCE:
 *   - unset / anything but "azure"  → search the local `app_users` table
 *     (the historical behaviour; used on staging).
 *   - "azure"                       → search the live Azure AD directory via
 *     Microsoft Graph (production). Each Graph match is resolved to an
 *     `app_users` row (JIT-provisioned by azure_oid) so the returned id can be
 *     stored as request_steps.approver_user_id / metadata.watchers.
 *
 * Always falls back to `app_users` if Graph is unconfigured or errors, so a
 * misconfiguration never breaks the picker.
 */

interface DirectoryResult {
  id: string;
  display_name: string;
  email: string;
  job_title: string | null;
  source: 'app_users' | 'azure_ad';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = session.user as any;
    const organizationId = user.org_id;
    const userId = user.id;
    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();

    // Local app_users search — used directly on staging and as the fallback.
    async function searchAppUsers(): Promise<DirectoryResult[]> {
      let query = supabaseAdmin
        .from('app_users')
        .select('id, display_name, email, job_title')
        .eq('organization_id', organizationId)
        .order('display_name', { ascending: true })
        .limit(25);

      if (q) {
        query = query.or(`display_name.ilike.%${q}%,email.ilike.%${q}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map((u) => ({
        id: u.id,
        display_name: u.display_name,
        email: u.email,
        job_title: (u as any).job_title ?? null,
        source: 'app_users' as const,
      }));
    }

    const useAzure = process.env.USER_DIRECTORY_SOURCE === 'azure' && isGraphDirectoryConfigured();

    // Local source, or query too short for a meaningful directory search.
    if (!useAzure || q.length < 2) {
      return res.status(200).json({
        users: await searchAppUsers(),
        source: useAzure ? 'app_users_short' : 'app_users',
      });
    }

    // Delegated directory search runs as the signed-in user (no app-only token),
    // so it inherits their Conditional-Access-compliant session. If the user
    // has no usable Graph token yet (e.g. signed in before User.Read.All was
    // granted, so they must re-authenticate), degrade to the local list.
    const graphToken = await getValidMsAccessToken(userId);
    if (!graphToken) {
      return res.status(200).json({ users: await searchAppUsers(), source: 'app_users_no_token' });
    }

    const dirUsers = await searchDirectoryUsers(graphToken, q);
    if (!dirUsers) {
      // Graph unavailable — degrade to the local list rather than failing.
      return res.status(200).json({ users: await searchAppUsers(), source: 'app_users_fallback' });
    }

    // Resolve each directory match to an app_users row so its id is FK-safe.
    const results: DirectoryResult[] = [];
    for (const du of dirUsers) {
      if (!du.azureOid || !du.email) continue;

      const { data: appUser, error } = await supabaseAdmin
        .from('app_users')
        .upsert(
          {
            organization_id: organizationId,
            azure_oid: du.azureOid,
            email: du.email,
            display_name: du.displayName,
            job_title: du.jobTitle,
          },
          { onConflict: 'organization_id,azure_oid' }
        )
        .select('id, display_name, email, job_title')
        .single();

      if (error || !appUser) {
        console.error('users/search: failed to provision app_user for', du.email, error?.message);
        continue;
      }

      results.push({
        id: appUser.id,
        display_name: appUser.display_name,
        email: appUser.email,
        job_title: (appUser as any).job_title ?? null,
        source: 'azure_ad',
      });
    }

    // Merge in local app_users matches too. A Microsoft Graph $search can miss a
    // person who is nonetheless already provisioned in app_users (e.g. their
    // mailbox attributes changed, or the search tokenised the query oddly) —
    // without this, an approver who "used to show" silently disappears from the
    // picker. Dedupe by id and by email so Graph results stay authoritative.
    const seenIds = new Set(results.map((r) => r.id));
    const seenEmails = new Set(results.map((r) => (r.email || '').toLowerCase()));
    for (const local of await searchAppUsers()) {
      if (seenIds.has(local.id)) continue;
      if (local.email && seenEmails.has(local.email.toLowerCase())) continue;
      results.push(local);
      seenIds.add(local.id);
      if (local.email) seenEmails.add(local.email.toLowerCase());
    }

    return res.status(200).json({ users: results, source: 'azure_ad' });
  } catch (error: any) {
    console.error('Users search API error:', error);
    return res.status(500).json({ error: error.message || 'Failed to search users' });
  }
}
