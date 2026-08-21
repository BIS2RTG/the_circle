/**
 * Shared Board Governance & Meeting Administration (BGM) types and constants.
 *
 * Client-safe: NO server-only imports (supabaseAdmin, next-auth) belong here so
 * this module can be used from both API routes and React components.
 */

// ---- Attendance (BGM-02) ----
export const ATTENDANCE_STATUSES = ['present', 'virtual', 'apology', 'absent'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  virtual: 'Virtual Attendance',
  apology: 'Apology',
  absent: 'Absent',
};

/** Tailwind class hints for status chips (badge bg + text). */
export const ATTENDANCE_STYLES: Record<AttendanceStatus, { bg: string; text: string; dot: string }> = {
  present: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  virtual: { bg: 'bg-sky-50', text: 'text-sky-700', dot: 'bg-sky-500' },
  apology: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  absent: { bg: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500' },
};

/** Statuses that count as having attended (present in person or virtually). */
export const ATTENDED_STATUSES: AttendanceStatus[] = ['present', 'virtual'];

// ---- RSVP (pre-meeting intent, distinct from actual attendance) ----
export const RSVP_STATUSES = ['no_response', 'accepted', 'declined', 'tentative'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const RSVP_LABELS: Record<RsvpStatus, string> = {
  no_response: 'Awaiting response',
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Tentative',
};

export const RSVP_STYLES: Record<RsvpStatus, { bg: string; text: string; dot: string }> = {
  no_response: { bg: 'bg-neutral-100', text: 'text-neutral-500', dot: 'bg-neutral-300' },
  accepted: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  declined: { bg: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500' },
  tentative: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
};

// ---- Check-in provenance (how attendance was captured) ----
export const CHECK_IN_METHOD_LABELS: Record<string, string> = {
  secretary: 'Marked by secretary',
  self_qr: 'QR self check-in',
  self_token: 'Self check-in (link)',
  teams: 'Teams attendance report',
  import: 'Imported record',
  in_person: 'Signed in person',
};

// ---- Meetings (BGM-01) ----
export const MEETING_TYPES = ['board', 'committee'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const INVITE_SCOPES = ['all_board', 'committee', 'custom'] as const;
export type InviteScope = (typeof INVITE_SCOPES)[number];

// ---- Virtual meeting platform ----
// RTG boards run on Zoom (single licence; link created manually by IT), but
// Teams / Google Meet / Other are supported. Only Teams can be auto-created via
// Graph; every other platform uses a pasted link.
export const VIRTUAL_PLATFORMS = ['zoom', 'teams', 'google_meet', 'other'] as const;
export type VirtualPlatform = (typeof VIRTUAL_PLATFORMS)[number];

export const VIRTUAL_PLATFORM_LABELS: Record<VirtualPlatform, string> = {
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  google_meet: 'Google Meet',
  other: 'Other',
};

/** Platforms whose join link the user pastes in (i.e. not auto-provisioned). */
export function platformNeedsManualLink(p: VirtualPlatform | null | undefined): boolean {
  return p !== 'teams';
}

export const MEETING_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// ---- Row shapes (loosely typed; DB access uses service role) ----
export interface Committee {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  is_main_board: boolean;
  is_active: boolean;
}

export interface Director {
  id: string;
  organization_id: string;
  full_name: string;
  salutation: string | null;
  email: string | null;
  phone: string | null;
  appointed_date: string | null;
  term_end_date: string | null;
  is_independent: boolean | null;
  status: 'active' | 'resigned' | 'retired' | 'suspended';
  notes: string | null;
}

export interface BoardMeeting {
  id: string;
  organization_id: string;
  title: string;
  meeting_type: MeetingType;
  committee_id: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  time_zone: string;
  location: string | null;
  is_virtual: boolean;
  virtual_link: string | null;
  agenda: string | null;
  calendar_year: number;
  status: MeetingStatus;
  outlook_event_id: string | null;
  outlook_web_link: string | null;
  invitations_sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttendanceRow {
  id: string;
  meeting_id: string;
  director_id: string;
  status: AttendanceStatus | null;
  rsvp_status: RsvpStatus;
  rsvp_note: string | null;
  note: string | null;
  checked_in_at: string | null;
  check_in_method: string | null;
  confirmed_by_director: boolean;
  recorded_by: string | null;
  recorded_at: string | null;
}

export interface MeetingGuest {
  id: string;
  meeting_id: string;
  full_name: string;
  email: string | null;
  organization: string | null;
  role: string | null;
  app_user_id: string | null;
  rsvp_status: RsvpStatus;
  status: AttendanceStatus | null;
  note: string | null;
}

/**
 * Default quorum = simple majority of invited directors (round up).
 * A meeting may override with an explicit `quorum`.
 */
export function defaultQuorum(invitedDirectors: number): number {
  return Math.floor(invitedDirectors / 2) + 1;
}

/** Compute a director's cumulative attendance summary from register rows. */
export function summariseAttendance(rows: { status: AttendanceStatus | null }[]) {
  const counts: Record<AttendanceStatus, number> = { present: 0, virtual: 0, apology: 0, absent: 0 };
  let recorded = 0;
  for (const r of rows) {
    if (r.status) {
      counts[r.status] += 1;
      recorded += 1;
    }
  }
  const attended = counts.present + counts.virtual;
  const rate = recorded > 0 ? Math.round((attended / recorded) * 100) : null;
  return { counts, recorded, attended, rate };
}
