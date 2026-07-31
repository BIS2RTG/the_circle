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
