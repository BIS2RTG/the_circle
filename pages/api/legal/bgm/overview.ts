import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { summariseAttendance, AttendanceStatus } from '@/lib/bgm';

/**
 * GET /api/legal/bgm/overview?year=
 * One authenticated call that returns everything the Board Governance hub needs
 * — committees (+members), meetings for the year (+attendance tally), directors
 * (+committees), and the cumulative attendance summary. Replaces four separate
 * round trips so the page loads fast.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireBgm(req, res, ['bgm.meetings.view', 'bgm.directors.view', 'legal.access']);
  if (!ctx) return;
  const org = ctx.organizationId;
  const year = req.query.year ? parseInt(String(req.query.year), 10) : new Date().getFullYear();

  // Fetch the independent datasets in parallel.
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
    // Attendance across the org's meetings, for per-director cumulative stats.
    supabaseAdmin.from('meeting_attendance')
      .select('director_id, status, meeting:board_meetings!inner(organization_id)')
      .eq('meeting.organization_id', org),
  ]);

  const committees = committeesRes.data || [];
  const directors = directorsRes.data || [];
  const meetings = meetingsRes.data || [];
  const memberships = (membershipsRes.data || []).filter((m: any) => m.director?.organization_id === org);

  // committees + members
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

  // meetings + attendance tally (for the shown year)
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

  // cumulative attendance summary per director
  const byDirector = new Map<string, { status: AttendanceStatus | null }[]>();
  for (const r of attendanceRes.data || []) {
    const list = byDirector.get((r as any).director_id) || [];
    list.push({ status: (r as any).status });
    byDirector.set((r as any).director_id, list);
  }
  const summary = directors.map((d) => ({ director: d, ...summariseAttendance(byDirector.get(d.id) || []) }));

  return res.status(200).json({ committees: committeesOut, directors: directorsOut, meetings: meetingsOut, summary });
}
