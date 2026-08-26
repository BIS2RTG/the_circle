/**
 * Fixed, locked approvers for specific forms.
 *
 * On the complimentary booking forms (internal staff + external guest) the
 * Chief Operating Officer signs off every request. The requester does NOT pick
 * this approver — the role is pre-filled and locked to the current COO.
 *
 * The role KEY stays `functional_head` (the slot the COO occupies in the comp
 * booking approval chain) so the existing approver-chain arrays, step building,
 * and stored `metadata.approverRoles` keep working unchanged — only the
 * on-screen label and the person are fixed.
 *
 * The COO is a DIFFERENT user in each environment (production vs the RTG
 * demo / local database), so we resolve them by matching any of the known COO
 * emails against the loaded org users — whichever exists in the current
 * database is the COO. This avoids hardcoding an environment-specific user id.
 * Update the email list here if the COO changes.
 */
export const COMP_BOOKING_COO = {
  ROLE_KEY: 'functional_head' as const,
  LABEL: 'Chief Operating Officer',
  /** Known COO addresses across environments (compared case-insensitively). */
  EMAILS: ['brain.maponde@rtg.co.zw', 'coo@rtg.demo'],
};

/**
 * Fixed CAPEX "Procurement and Projects Manager" approver.
 *
 * This role is a single named person (Bornwell Muchirahondo in production), NOT
 * a per-unit / departmental slot, so it is pinned by email and left locked (the
 * `procurement_manager` role is deliberately kept out of
 * CHANGEABLE_AUTO_APPROVER_ROLES in lib/approverLocking.ts). Pinning by email
 * makes resolution robust even when the HRIMS position title drifts (it is
 * "Procurement & Projects Manager" — with an ampersand — in production, which
 * an exact title match would otherwise miss).
 *
 * Like the COO above, the person differs per environment, so we match any of the
 * known emails against the loaded users — whichever exists in the current
 * database wins. Update this list if the role holder changes.
 */
export const CAPEX_PROCUREMENT_MANAGER = {
  ROLE_KEY: 'procurement_manager' as const,
  LABEL: 'Procurement and Projects Manager',
  /** Known holder addresses across environments (compared case-insensitively). */
  EMAILS: ['bornwell.muchirahondo@rtg.co.zw'],
};

/**
 * Board-member complimentary bookings run a DIFFERENT approval chain:
 *   Company Secretary → Chief Finance Officer → CEO.
 *
 * The Company Secretary holds the HRIMS position "Chief Strategy, Growth and
 * Investment Officer", so we resolve each of these three by matching known job
 * titles against the loaded org users (works without a live HRIMS connection —
 * the legal/staging environments deliberately have none). The requester can
 * still override any slot manually if a title match isn't found.
 */
export const BOARD_COMP_APPROVERS: Array<{
  key: 'company_secretary' | 'cfo' | 'ceo';
  label: string;
  description: string;
  /** Job titles that identify this holder (case-insensitive, matched loosely). */
  titles: string[];
  /**
   * Optional known email(s) that pin this holder regardless of HRIMS title
   * drift (matched case-insensitively). Resolved BEFORE the title match — the
   * same robust approach used for the COO and Procurement Manager above. Update
   * if the role holder changes.
   */
  emails?: string[];
}> = [
  {
    key: 'company_secretary',
    label: 'Company Secretary',
    description: 'Chief Strategy, Growth and Investment Officer',
    // Pin by email so the Company Secretary always auto-fills even when the
    // HRIMS/Azure job title uses an ampersand ("...Growth & Investment
    // Officer") that a title match would otherwise miss.
    emails: ['tapiwa.mari@rtg.co.zw'],
    titles: [
      'chief strategy, growth and investment officer',
      'chief strategy growth and investment officer',
      'chief strategy, growth & investment officer',
      'chief strategy growth & investment officer',
      'company secretary',
      'group company secretary',
    ],
  },
  {
    key: 'cfo',
    label: 'Chief Finance Officer',
    description: 'Finance Approval',
    titles: [
      'chief finance officer',
      'chief financial officer',
      'cfo',
      'group finance director',
      'finance director',
    ],
  },
  {
    key: 'ceo',
    label: 'CEO',
    description: 'Authorisation',
    titles: [
      'chief executive officer',
      'group chief executive',
      'group ceo',
      'ceo',
      'managing director',
    ],
  },
];

/**
 * Normalise a job title for tolerant comparison: lower-case, collapse
 * whitespace, and treat "&" and "and" as equivalent. Without the ampersand
 * fold, a holder whose HRIMS/Azure title reads "Chief Strategy, Growth &
 * Investment Officer" would never match the "...and Investment Officer" variant
 * we search for (the Company Secretary auto-fill bug).
 */
function normalizeJobTitle(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find a user in a loaded list whose job title matches one of `titles`
 * (case-insensitive; "&" and "and" are equivalent; exact-after-normalise first,
 * then a contains match). Returns null when none is found.
 */
export function resolveByJobTitle<T extends { job_title?: string | null }>(
  users: T[] | null | undefined,
  titles: string[]
): T | null {
  if (!users?.length) return null;
  const wanted = titles.map(normalizeJobTitle);
  const norm = (u: T) => normalizeJobTitle(u.job_title || '');
  return (
    users.find((u) => wanted.includes(norm(u))) ||
    users.find((u) => { const t = norm(u); return !!t && wanted.some((w) => t.includes(w) || w.includes(t)); }) ||
    null
  );
}

/**
 * Resolve one of the board-comp approver holders from a loaded user list:
 * pinned email(s) first (robust to HRIMS title drift), then a job-title match.
 * Returns null when neither locates a user. Never returns `excludeUserId` (the
 * requester can't approve their own request).
 */
export function resolveBoardApprover<
  T extends { id: string; email?: string | null; job_title?: string | null }
>(
  users: T[] | null | undefined,
  role: { emails?: string[]; titles: string[] },
  excludeUserId?: string
): T | null {
  if (!users?.length) return null;
  const pool = excludeUserId ? users.filter((u) => u.id !== excludeUserId) : users;
  if (role.emails?.length) {
    const wanted = new Set(role.emails.map((e) => e.toLowerCase()));
    const byEmail = pool.find((u) => !!u.email && wanted.has(u.email.toLowerCase()));
    if (byEmail) return byEmail;
  }
  return resolveByJobTitle(pool, role.titles);
}

/** Request types (metadata.type / category) that are complimentary bookings. */
export const COMP_BOOKING_TYPES = new Set(['hotel_booking', 'external_hotel_booking']);

/**
 * Find the fixed COO within a loaded user list by matching a known COO email
 * (case-insensitive). Returns null when none is present.
 */
export function resolveCompBookingCoo<T extends { id: string; email?: string | null }>(
  users: T[] | null | undefined
): T | null {
  if (!users?.length) return null;
  const wanted = new Set(COMP_BOOKING_COO.EMAILS.map((e) => e.toLowerCase()));
  return users.find((u) => !!u.email && wanted.has(u.email.toLowerCase())) || null;
}
