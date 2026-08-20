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
import { summariseAttendance, AttendanceStatus } from './bgm';

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
