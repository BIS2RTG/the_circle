/**
 * BGM-05 / BGM-07 — shared, CLIENT-SAFE constants for the Director Portal and
 * secure tokenised links. NO server-only imports (used by portal pages,
 * the public link page and the admin UI).
 */

export const DIRECTOR_ACTIONS = ['portal_login', 'confirm_attendance', 'sign_declaration', 'update_profile'] as const;
export type DirectorAction = (typeof DIRECTOR_ACTIONS)[number];

export const DIRECTOR_ACTION_LABELS: Record<DirectorAction, string> = {
  portal_login: 'Portal sign-in',
  confirm_attendance: 'Confirm attendance',
  sign_declaration: 'Sign declaration',
  update_profile: 'Update profile',
};

/** Default single-action / login link lifetime (days). Configurable per org. */
export const DEFAULT_TOKEN_DAYS = 7;
export const MIN_TOKEN_DAYS = 1;
export const MAX_TOKEN_DAYS = 90;

/** Portal session lifetime (hours). */
export const PORTAL_SESSION_HOURS = 8;

export const ACCESS_EVENT_LABELS: Record<string, string> = {
  token_issued: 'Link issued',
  token_opened: 'Link opened',
  token_completed: 'Action completed',
  token_expired: 'Expired link used',
  token_invalid: 'Invalid link',
  token_revoked: 'Link revoked',
  login: 'Portal sign-in',
  logout: 'Portal sign-out',
  session_expired: 'Session expired',
  profile_updated: 'Profile updated',
  attendance_confirmed: 'Attendance confirmed',
  declaration_signed: 'Declaration signed',
  viewed: 'Viewed',
  denied: 'Access denied',
};

export function accessEventLabel(t: string): string {
  return ACCESS_EVENT_LABELS[t] || t;
}
