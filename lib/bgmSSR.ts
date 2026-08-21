/**
 * Server-side data loaders + auth gate for the Legal/BGM pages, so they can
 * render with their data already in the HTML (SSR) instead of flashing a loader
 * and fetching on the client. Each loader mirrors the matching API route; the
 * pages keep a client refetch for use after mutations.
 */
import type { GetServerSidePropsContext } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../pages/api/auth/[...nextauth]';
import { getUserRBACProfile, hasAnyPermission } from './rbac';
import { supabaseAdmin } from './supabaseAdmin';
import { summariseAttendance, AttendanceStatus, defaultQuorum } from './bgm';

export interface BgmSsrCtx { userId: string; organizationId: string; }
type Gate = { redirect: { destination: string; permanent: boolean } } | { ctx: BgmSsrCtx };

/** Session + permission gate for a getServerSideProps. */
export async function requireBgmSSR(context: GetServerSidePropsContext, permissions: string[]): Promise<Gate> {
  const session = await getServerSession(context.req, context.res, authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) return { redirect: { destination: '/', permanent: false } };
  const organizationId = (session!.user as any).org_id;
  if (permissions.length > 0) {
    const profile = await getUserRBACProfile(userId);
    if (!hasAnyPermission(profile, permissions)) return { redirect: { destination: '/dashboard', permanent: false } };
  }
  return { ctx: { userId, organizationId } };
}

/** JSON-safe clone (Date/undefined → string/null) for getServerSideProps props. */
export function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

/**
 * The Board Governance hub payload — committees(+members), directors(+committees),
 * meetings(+attendance tally) for the year, and the cumulative attendance summary.
 * Shared by /api/legal/bgm/overview and the /legal/board SSR.
 */
export async function buildBoardOverview(organizationId: string, year: number) {
  const org = organizationId;
  const [committeesRes, directorsRes, meetingsRes, membershipsRes, attendanceRes] = await Promise.all([
    supabaseAdmin.from('committees')
      .select('id, name, slug, description, is_main_board, is_active')
      .eq('organization_id', org).order('is_main_board', { ascending: false }).order('name'),
    supabaseAdmin.from('directors')
      .select('id, full_name, salutation, email, phone, appointed_date, term_end_date, is_independent, status, notes')
      .eq('organization_id', org).order('full_name'),
    supabaseAdmin.from('board_meetings')
      .select('*, committee:committees(id, name, slug)')
      .eq('organization_id', org).eq('calendar_year', year).order('scheduled_start', { ascending: true }),
    supabaseAdmin.from('committee_memberships')
      .select('committee_id, director_id, is_chair, committee:committees(id, name, slug), director:directors(id, full_name, salutation, status, organization_id)'),
    supabaseAdmin.from('meeting_attendance')
      .select('director_id, status, meeting:board_meetings!inner(organization_id)')
      .eq('meeting.organization_id', org),
  ]);

  const committees = committeesRes.data || [];
  const directors = directorsRes.data || [];
  const meetings = meetingsRes.data || [];
  const memberships = (membershipsRes.data || []).filter((m: any) => m.director?.organization_id === org);

  const membersByCommittee = new Map<string, any[]>();
  const committeesByDirector = new Map<string, any[]>();
  for (const m of memberships) {
    if (m.director) {
      const list = membersByCommittee.get(m.committee_id) || [];
      list.push({ ...m.director, is_chair: m.is_chair });
      membersByCommittee.set(m.committee_id, list);
    }
    if (m.committee) {
      const list = committeesByDirector.get(m.director_id) || [];
      list.push({ ...m.committee, is_chair: m.is_chair });
      committeesByDirector.set(m.director_id, list);
    }
  }
  const committeesOut = committees.map((c) => {
    const members = (membersByCommittee.get(c.id) || []).sort((a, b) =>
      a.is_chair === b.is_chair ? a.full_name.localeCompare(b.full_name) : a.is_chair ? -1 : 1);
    return { ...c, members, member_count: members.length };
  });
  const directorsOut = directors.map((d) => ({ ...d, committees: committeesByDirector.get(d.id) || [] }));

  const meetingIds = meetings.map((m) => m.id);
  const tally = new Map<string, { invited: number; recorded: number; present: number }>();
  if (meetingIds.length > 0) {
    const { data: rows } = await supabaseAdmin
      .from('meeting_attendance').select('meeting_id, status').in('meeting_id', meetingIds);
    for (const r of rows || []) {
      const t = tally.get(r.meeting_id) || { invited: 0, recorded: 0, present: 0 };
      t.invited += 1;
      if (r.status) t.recorded += 1;
      if (r.status === 'present' || r.status === 'virtual') t.present += 1;
      tally.set(r.meeting_id, t);
    }
  }
  const meetingsOut = meetings.map((m) => ({ ...m, attendance_tally: tally.get(m.id) || { invited: 0, recorded: 0, present: 0 } }));

  const byDirector = new Map<string, { status: AttendanceStatus | null }[]>();
  for (const r of attendanceRes.data || []) {
    const list = byDirector.get((r as any).director_id) || [];
    list.push({ status: (r as any).status });
    byDirector.set((r as any).director_id, list);
  }
  const summary = directors.map((d) => ({ director: d, ...summariseAttendance(byDirector.get(d.id) || []) }));

  return { committees: committeesOut, directors: directorsOut, meetings: meetingsOut, summary };
}

/** Committees for the org, each with its members (+chair). Shared by the API and SSR. */
export async function buildCommitteesList(organizationId: string) {
  const { data: committees } = await supabaseAdmin
    .from('committees')
    .select('id, name, slug, description, is_main_board, is_active')
    .eq('organization_id', organizationId)
    .order('is_main_board', { ascending: false }).order('name');

  const ids = (committees || []).map((c) => c.id);
  let memberships: any[] = [];
  if (ids.length > 0) {
    const { data } = await supabaseAdmin
      .from('committee_memberships')
      .select('committee_id, is_chair, director:directors(id, full_name, salutation, status)')
      .in('committee_id', ids);
    memberships = data || [];
  }
  const byCommittee = new Map<string, any[]>();
  for (const m of memberships) {
    const list = byCommittee.get(m.committee_id) || [];
    list.push({ ...m.director, is_chair: m.is_chair });
    byCommittee.set(m.committee_id, list);
  }
  return (committees || []).map((c) => {
    const members = (byCommittee.get(c.id) || []).sort((a, b) =>
      a.is_chair === b.is_chair ? a.full_name.localeCompare(b.full_name) : a.is_chair ? -1 : 1);
    return { ...c, members, member_count: members.length };
  });
}

/**
 * Whether a board member counts as an HRIMS / staff member (they have a login and
 * signature already, so they skip the external terms-before-sign step).
 *   * is_hrims = true/false  → explicit manual override, always wins.
 *   * is_hrims = null        → auto-detect: their email matches a staff login.
 */
export async function isDirectorHrims(director: { email?: string | null; is_hrims?: boolean | null }): Promise<boolean> {
  if (director.is_hrims === true || director.is_hrims === false) return director.is_hrims;
  const email = (director.email || '').trim();
  if (!email) return false;
  const { data } = await supabaseAdmin
    .from('app_users').select('id').ilike('email', email).maybeSingle();
  return !!data;
}

/** What a board member is acknowledging when they sign, given their recorded status. */
export function attendanceAcknowledgment(status: string | null | undefined, meetingTitle: string): string {
  const t = `“${meetingTitle}”`;
  switch (status) {
    case 'apology': return `that you tendered an apology and did not attend ${t}`;
    case 'absent': return `that you were recorded as absent from ${t}`;
    case 'present':
    case 'virtual': return `that you attended ${t}`;
    default: return `your attendance at ${t}`;
  }
}

/**
 * Resolve a public sign/attend token to everything the /board/attend page needs,
 * so the page can render server-side (SSR) instead of fetching on the client.
 * Mirrors GET /api/legal/bgm/attend/[token]. Never throws.
 */
export async function buildAttendView(token: string) {
  if (!token) return { valid: false as const, error: 'This attendance link is not valid.' };

  const { data: dir } = await supabaseAdmin
    .from('meeting_attendance')
    .select('id, meeting_id, status, check_in_signature, director:directors(id, full_name, salutation, email, is_hrims, saved_signature, terms_accepted_at)')
    .eq('checkin_token', token).maybeSingle();

  let kind: 'director' | 'guest' = 'director';
  let director: any = null;
  let row: { meeting_id: string; status: string | null; name: string; signed: boolean } | null = null;

  if (dir) {
    director = (dir as any).director;
    row = { meeting_id: (dir as any).meeting_id, status: (dir as any).status, name: director?.full_name || 'Director', signed: !!(dir as any).check_in_signature };
  } else {
    const { data: guest } = await supabaseAdmin
      .from('meeting_guests')
      .select('id, meeting_id, status, full_name, check_in_signature')
      .eq('checkin_token', token).maybeSingle();
    if (guest) { kind = 'guest'; row = { meeting_id: (guest as any).meeting_id, status: (guest as any).status, name: (guest as any).full_name, signed: !!(guest as any).check_in_signature }; }
  }
  if (!row) return { valid: false as const, error: 'This attendance link is not valid.' };

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, title, scheduled_start, scheduled_end, status, finalized_at, is_virtual')
    .eq('id', row.meeting_id).maybeSingle();
  if (!meeting) return { valid: false as const, error: 'Meeting not found.' };

  const start = new Date(meeting.scheduled_start).getTime();
  const now = Date.now();
  const open = now >= start - 3 * 3600_000 && meeting.status !== 'cancelled' && !meeting.finalized_at;
  const isHrims = kind === 'director' ? await isDirectorHrims(director || {}) : true;
  const termsAccepted = kind === 'director' ? !!director?.terms_accepted_at : true;

  return {
    valid: true as const,
    name: row.name,
    meeting: { title: meeting.title, scheduled_start: meeting.scheduled_start, is_virtual: meeting.is_virtual },
    already: row.signed,
    open,
    is_hrims: isHrims,
    terms_required: kind === 'director' && !isHrims && !termsAccepted,
    saved_signature: kind === 'director' ? (director?.saved_signature || null) : null,
    status: row.status,
    acknowledgment: attendanceAcknowledgment(row.status, meeting.title),
  };
}

/** Meeting detail + attendance register (mirrors GET /api/legal/bgm/meetings/[id]) for SSR. */
export async function buildMeetingDetail(organizationId: string, id: string) {
  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('*, committee:committees(id, name, slug)')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (!meeting) return null;

  const { data: register } = await supabaseAdmin
    .from('meeting_attendance')
    .select('id, director_id, status, rsvp_status, rsvp_note, note, checked_in_at, check_in_method, check_in_signature, checkin_link_sent_at, confirmed_by_director, recorded_at, director:directors(id, full_name, salutation, email, status)')
    .eq('meeting_id', id);

  const rows = (register || [])
    .map((r: any) => ({
      id: r.id,
      director_id: r.director_id,
      status: r.status,
      rsvp_status: r.rsvp_status,
      rsvp_note: r.rsvp_note,
      note: r.note,
      checked_in_at: r.checked_in_at,
      check_in_method: r.check_in_method,
      check_in_signature: r.check_in_signature,
      checkin_link_sent_at: r.checkin_link_sent_at,
      confirmed_by_director: r.confirmed_by_director,
      recorded_at: r.recorded_at,
      full_name: r.director?.full_name,
      salutation: r.director?.salutation,
      email: r.director?.email,
    }))
    .sort((a: any, b: any) => (a.full_name || '').localeCompare(b.full_name || ''));

  const { data: guests } = await supabaseAdmin
    .from('meeting_guests')
    .select('id, full_name, email, organization, role, app_user_id, rsvp_status, status, note, checked_in_at, check_in_signature, checkin_link_sent_at')
    .eq('meeting_id', id)
    .order('full_name');

  const quorum = (meeting as any).quorum ?? defaultQuorum(rows.length);

  let finalized_by_name: string | null = null;
  if ((meeting as any).finalized_by) {
    const { data: fu } = await supabaseAdmin
      .from('app_users').select('display_name').eq('id', (meeting as any).finalized_by).maybeSingle();
    finalized_by_name = fu?.display_name || null;
  }

  return { meeting: { ...meeting, finalized_by_name }, register: rows, guests: guests || [], quorum };
}

/** A single director's profile, committees and cumulative attendance history. */
export async function buildDirectorDetail(organizationId: string, id: string) {
  const { data: director } = await supabaseAdmin
    .from('directors').select('*').eq('id', id).eq('organization_id', organizationId).maybeSingle();
  if (!director) return null;

  const { data: memberships } = await supabaseAdmin
    .from('committee_memberships').select('is_chair, committee:committees(id, name, slug)').eq('director_id', id);

  const { data: attendance } = await supabaseAdmin
    .from('meeting_attendance')
    .select('status, note, meeting:board_meetings(id, title, meeting_type, scheduled_start, status)')
    .eq('director_id', id);

  const history = (attendance || [])
    .filter((a: any) => a.meeting)
    .sort((a: any, b: any) => new Date(b.meeting.scheduled_start).getTime() - new Date(a.meeting.scheduled_start).getTime())
    .map((a: any) => ({
      status: a.status as AttendanceStatus | null,
      note: a.note,
      meeting_id: a.meeting.id,
      meeting_title: a.meeting.title,
      meeting_type: a.meeting.meeting_type,
      scheduled_start: a.meeting.scheduled_start,
      meeting_status: a.meeting.status,
    }));

  return {
    director,
    committees: (memberships || []).map((m: any) => ({ ...m.committee, is_chair: m.is_chair })),
    history,
    summary: summariseAttendance(history),
  };
}
