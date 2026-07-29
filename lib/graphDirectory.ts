/**
 * Microsoft Graph directory search (DELEGATED — on behalf of the signed-in user).
 *
 * Searches the organisation's Azure AD (Entra ID) directory for people — used
 * when picking approvers / watchers, and when resolving an approver who exists
 * in the directory but hasn't yet signed into The Circle.
 *
 * Runs with the SIGNED-IN USER'S delegated Graph token (obtained via
 * getValidMsAccessToken and passed in by the caller), NOT an app-only
 * credential. This means the calls ride the user's already
 * Conditional-Access-compliant session, so no workload-identity CA exemption is
 * required. Requires the DELEGATED Graph permission `User.Read.All` granted with
 * admin consent, and `User.Read.All` requested in the sign-in scopes (see
 * authOptions) and the refresh scope (see msTokenStore MS_SCOPE).
 *
 * Degrades gracefully: returns `null` on a missing token or any Graph error, so
 * callers can fall back to the local `app_users` list.
 */

export function isGraphDirectoryConfigured(): boolean {
  return !!(
    process.env.AZURE_CLIENT_ID &&
    process.env.AZURE_CLIENT_SECRET &&
    process.env.AZURE_TENANT
  );
}

export interface DirectoryUser {
  /** Azure AD object id (oid) — stored as app_users.azure_oid. */
  azureOid: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
}

/**
 * Exchange-generated system / service mailboxes (health-monitoring, eDiscovery,
 * migration, arbitration, the federation account, etc.). These are real,
 * enabled directory objects, so they slip past the `accountEnabled` check and a
 * name/UPN `$search`, but they are never valid approvers or watchers and must
 * not be JIT-provisioned into `app_users`. Matched on the displayName/UPN
 * localpart, which Microsoft always prefixes with one of these fixed strings.
 */
const SYSTEM_MAILBOX_PREFIXES = [
  'healthmailbox',
  'discoverysearchmailbox',
  'systemmailbox',
  'migration.',
  'federatedemail.',
  'exchange online-applicationaccount',
];

function isSystemMailbox(displayName?: string, userPrincipalName?: string, mail?: string): boolean {
  const candidates = [displayName, userPrincipalName, mail]
    .filter(Boolean)
    .map((s) => (s as string).trim().toLowerCase());
  return candidates.some((c) =>
    SYSTEM_MAILBOX_PREFIXES.some((prefix) => c.startsWith(prefix))
  );
}

/**
 * Search directory users by name or email using a delegated access token.
 * Returns up to `top` matches, or `null` if the token is missing or Graph is
 * unavailable (caller should fall back to app_users).
 */
export async function searchDirectoryUsers(
  accessToken: string | null,
  query: string,
  top = 20
): Promise<DirectoryUser[] | null> {
  if (!accessToken) return null;

  // Strip quotes to keep the $search expression well-formed.
  const safe = query.replace(/"/g, '').trim();
  if (!safe) return [];

  const params = new URLSearchParams();
  params.set('$search', `"displayName:${safe}" OR "mail:${safe}" OR "userPrincipalName:${safe}"`);
  params.set('$select', 'id,displayName,mail,userPrincipalName,jobTitle,accountEnabled');
  params.set('$top', String(top));

  const resp = await fetch(`https://graph.microsoft.com/v1.0/users?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // $search on the users collection requires advanced query capabilities.
      ConsistencyLevel: 'eventual',
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('graphDirectory: user search failed:', resp.status, text);
    return null;
  }

  const json: any = await resp.json();
  return (json.value || [])
    .filter((u: any) => u.accountEnabled !== false)
    .filter((u: any) => !isSystemMailbox(u.displayName, u.userPrincipalName, u.mail))
    .map((u: any) => ({
      azureOid: u.id,
      displayName: u.displayName || u.userPrincipalName || u.mail || 'Unknown',
      email: u.mail || u.userPrincipalName || '',
      jobTitle: u.jobTitle || null,
    }));
}

/**
 * Look up a single directory user by their exact email (mail or UPN) using a
 * delegated access token. Used to resolve an HRIMS employee onto their Azure AD
 * identity so approver resolution can provision an `app_users` row keyed on the
 * real `azure_oid` (a later interactive sign-in then reuses that row rather than
 * creating a duplicate).
 *
 * Returns `null` if the token is missing, Graph is unavailable, or no matching
 * directory user exists.
 */
export async function getDirectoryUserByEmail(
  accessToken: string | null,
  email: string
): Promise<DirectoryUser | null> {
  if (!accessToken) return null;

  const safe = (email || '').replace(/'/g, "''").trim();
  if (!safe) return null;

  const params = new URLSearchParams();
  params.set('$filter', `mail eq '${safe}' or userPrincipalName eq '${safe}'`);
  params.set('$select', 'id,displayName,mail,userPrincipalName,jobTitle,accountEnabled');
  params.set('$top', '1');

  const resp = await fetch(`https://graph.microsoft.com/v1.0/users?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('graphDirectory: getUserByEmail failed:', resp.status, text);
    return null;
  }

  const json: any = await resp.json();
  const u = (json.value || [])[0];
  if (!u || u.accountEnabled === false) return null;
  if (isSystemMailbox(u.displayName, u.userPrincipalName, u.mail)) return null;

  return {
    azureOid: u.id,
    displayName: u.displayName || u.userPrincipalName || u.mail || 'Unknown',
    email: u.mail || u.userPrincipalName || '',
    jobTitle: u.jobTitle || null,
  };
}
