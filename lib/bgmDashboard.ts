/**
 * BGM-08 — Governance Reporting Dashboard aggregation (server-only).
 * One query pass builds every dashboard panel and the exportable summary:
 * attendance statistics, director tenure limits, outstanding declarations,
 * committee compositions and upcoming governance milestones.
 */
import { supabaseAdmin } from './supabaseAdmin';
import { ATTENDED_STATUSES, AttendanceStatus } from './bgm';
import { declarationLabel } from './bgmDeclarations';

/** Default independence tenure limit (years) — King IV guidance. Configurable. */
export const DEFAULT_TENURE_LIMIT_YEARS = 9;

async function getTenureLimit(organizationId: string): Promise<number> {
  try {
    const { data } = await supabaseAdmin
      .from('system_settings').select('value')
      .eq('organization_id', organizationId).eq('category', 'preferences').eq('key', 'director_tenure_years').maybeSingle();
    const raw = (data as any)?.value;
    const num = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    return Number.isFinite(num) && num > 0 ? num : DEFAULT_TENURE_LIMIT_YEARS;
  } catch { return DEFAULT_TENURE_LIMIT_YEARS; }
}

function yearsBetween(fromIso: string, to: Date): number {
  return (to.getTime() - new Date(fromIso).getTime()) / (365.25 * 24 * 3600 * 1000);
}
function addYears(iso: string, years: number): Date {
  const d = new Date(iso); d.setFullYear(d.getFullYear() + years); return d;
}
function daysUntil(d: Date, now: Date): number {
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

export interface GovernanceDashboard {
  year: number;
  generatedAt: string;
  tenureLimitYears: number;
  kpis: {
    activeDirectors: number;
    attendanceRate: number | null;
    meetingsHeld: number;
    meetingsScheduled: number;
    outstandingDeclarations: number;
    overdueDeclarations: number;
    committees: number;
    tenureAlerts: number;
  };
  attendance: {
    overallRate: number | null;
    byMeeting: { id: string; title: string; date: string; invited: number; attended: number; recorded: number; rate: number | null }[];
    byCommittee: { name: string; meetings: number; rate: number | null }[];
    byDirector: { id: string; name: string; invited: number; attended: number; recorded: number; rate: number | null }[];
  };
  tenure: {
    limitYears: number;
    distribution: { bucket: string; count: number }[];
    directors: { id: string; name: string; appointed: string | null; years: number | null; termEnd: string | null; independent: boolean | null; status: 'ok' | 'approaching' | 'over' | 'unknown' }[];
  };
  declarations: {
    completionRate: number | null;
    byType: { type: string; label: string; issued: number; submitted: number }[];
    outstanding: { id: string; director: string; label: string; periodYear: number | null; due: string | null; overdue: boolean }[];
  };
  committees: { id: string; name: string; isMainBoard: boolean; members: number; chair: string | null; independent: number; independentPct: number | null }[];
  milestones: { date: string; days: number; kind: 'meeting' | 'declaration_due' | 'term_end' | 'tenure_limit'; label: string; detail: string | null }[];
}

export async function buildGovernanceDashboard(organizationId: string, year: number): Promise<GovernanceDashboard> {
  const now = new Date();
  const tenureLimitYears = await getTenureLimit(organizationId);

  const [directorsRes, committeesRes, membershipsRes, meetingsRes, futureRes, declRes] = await Promise.all([
    supabaseAdmin.from('directors')
      .select('id, full_name, salutation, appointed_date, term_end_date, is_independent, status')
      .eq('organization_id', organizationId),
    supabaseAdmin.from('committees')
      .select('id, name, is_main_board, is_active').eq('organization_id', organizationId),
    supabaseAdmin.from('committee_memberships')
      .select('committee_id, director_id, is_chair, director:directors(id, full_name, is_independent, organization_id, status)'),
    supabaseAdmin.from('board_meetings')
      .select('id, title, meeting_type, committee_id, scheduled_start, status')
      .eq('organization_id', organizationId).eq('calendar_year', year).order('scheduled_start'),
    supabaseAdmin.from('board_meetings')
      .select('id, title, scheduled_start, committee_id, meeting_type, status')
      .eq('organization_id', organizationId).eq('status', 'scheduled').gte('scheduled_start', now.toISOString())
      .order('scheduled_start').limit(30),
    supabaseAdmin.from('governance_declarations')
      .select('id, director_id, declaration_type, status, period_year, due_date, submitted_at, director:directors(full_name)')
      .eq('organization_id', organizationId),
  ]);

  const directors = (directorsRes.data || []);
  const activeDirectors = directors.filter((d) => d.status === 'active');
  const committees = (committeesRes.data || []);
  const memberships: any[] = (membershipsRes.data || []).filter((m: any) => m.director?.organization_id === organizationId);
  const meetings = (meetingsRes.data || []);
  const declarations = (declRes.data || []);

  // ---- Attendance ----
  const meetingIds = meetings.map((m) => m.id);
  let attRows: { meeting_id: string; director_id: string; status: AttendanceStatus | null }[] = [];
  if (meetingIds.length > 0) {
    const { data } = await supabaseAdmin.from('meeting_attendance').select('meeting_id, director_id, status').in('meeting_id', meetingIds);
    attRows = (data || []) as any;
  }
  const attByMeeting = new Map<string, typeof attRows>();
  const attByDirector = new Map<string, { attended: number; recorded: number; invited: number }>();
  for (const r of attRows) {
    (attByMeeting.get(r.meeting_id) || attByMeeting.set(r.meeting_id, []).get(r.meeting_id)!).push(r);
    const d = attByDirector.get(r.director_id) || { attended: 0, recorded: 0, invited: 0 };
    d.invited += 1;
    if (r.status) { d.recorded += 1; if (ATTENDED_STATUSES.includes(r.status)) d.attended += 1; }
    attByDirector.set(r.director_id, d);
  }
  const heldMeetings = meetings.filter((m) => m.status === 'completed');
  const byMeeting = meetings.map((m) => {
    const rows = attByMeeting.get(m.id) || [];
    const invited = rows.length;
    const recorded = rows.filter((r) => r.status).length;
    const attended = rows.filter((r) => r.status && ATTENDED_STATUSES.includes(r.status)).length;
    return { id: m.id, title: m.title, date: m.scheduled_start, invited, attended, recorded, rate: recorded > 0 ? Math.round((attended / recorded) * 100) : null };
  });
  let totAttended = 0, totRecorded = 0;
  for (const r of attRows) { if (r.status) { totRecorded += 1; if (ATTENDED_STATUSES.includes(r.status)) totAttended += 1; } }
  const overallRate = totRecorded > 0 ? Math.round((totAttended / totRecorded) * 100) : null;

  const dirName = new Map(directors.map((d) => [d.id, d.full_name] as [string, string]));
  const byDirector = Array.from(attByDirector.entries())
    .map(([id, v]) => ({ id, name: dirName.get(id) || 'Director', invited: v.invited, attended: v.attended, recorded: v.recorded, rate: v.recorded > 0 ? Math.round((v.attended / v.recorded) * 100) : null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

  // Attendance grouped by committee (board meetings roll up to "Main Board").
  const committeeName = new Map(committees.map((c) => [c.id, c.name] as [string, string]));
  const commAgg = new Map<string, { meetings: number; attended: number; recorded: number }>();
  for (const m of meetings) {
    const key = m.meeting_type === 'committee' && m.committee_id ? (committeeName.get(m.committee_id) || 'Committee') : 'Main Board';
    const agg = commAgg.get(key) || { meetings: 0, attended: 0, recorded: 0 };
    agg.meetings += 1;
    for (const r of attByMeeting.get(m.id) || []) if (r.status) { agg.recorded += 1; if (ATTENDED_STATUSES.includes(r.status)) agg.attended += 1; }
    commAgg.set(key, agg);
  }
  const byCommittee = Array.from(commAgg.entries()).map(([name, v]) => ({ name, meetings: v.meetings, rate: v.recorded > 0 ? Math.round((v.attended / v.recorded) * 100) : null }));

  // ---- Tenure ----
  const buckets = { '0–3y': 0, '3–6y': 0, '6–9y': 0, '9y+': 0 } as Record<string, number>;
  const tenureDirectors = activeDirectors.map((d) => {
    const years = d.appointed_date ? yearsBetween(d.appointed_date, now) : null;
    let status: 'ok' | 'approaching' | 'over' | 'unknown' = 'unknown';
    if (years !== null) {
      if (years >= tenureLimitYears) status = 'over';
      else if (years >= tenureLimitYears - 1) status = 'approaching';
      else status = 'ok';
      if (status !== 'over' && d.term_end_date) {
        const du = daysUntil(new Date(d.term_end_date), now);
        if (du >= 0 && du <= 183) status = 'approaching';
      }
      const b = years < 3 ? '0–3y' : years < 6 ? '3–6y' : years < 9 ? '6–9y' : '9y+';
      buckets[b] += 1;
    }
    return {
      id: d.id, name: d.full_name, appointed: d.appointed_date, years: years === null ? null : Math.round(years * 10) / 10,
      termEnd: d.term_end_date, independent: d.is_independent, status,
    };
  }).sort((a, b) => (b.years ?? -1) - (a.years ?? -1));
  const tenureAlerts = tenureDirectors.filter((d) => d.status === 'over' || d.status === 'approaching').length;

  // ---- Declarations ----
  const DECL_TYPES = ['director_information', 'declaration_of_interest', 'related_party', 'annual_governance', 'board_evaluation'];
  const relevant = declarations.filter((d) => d.period_year === year || d.period_year === null);
  const byType = DECL_TYPES.map((t) => {
    const forType = relevant.filter((d) => d.declaration_type === t);
    return { type: t, label: declarationLabel(t), issued: forType.filter((d) => d.status === 'issued').length, submitted: forType.filter((d) => d.status === 'submitted').length };
  });
  const outstandingAll = declarations.filter((d) => d.status === 'issued');
  const outstanding = outstandingAll.map((d: any) => ({
    id: d.id, director: d.director?.full_name || 'Director', label: declarationLabel(d.declaration_type),
    periodYear: d.period_year, due: d.due_date, overdue: !!d.due_date && new Date(d.due_date).getTime() < now.getTime(),
  })).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  const submittedCount = relevant.filter((d) => d.status === 'submitted').length;
  const issuedCount = relevant.filter((d) => d.status === 'issued').length;
  const completionRate = submittedCount + issuedCount > 0 ? Math.round((submittedCount / (submittedCount + issuedCount)) * 100) : null;

  // ---- Committee compositions ----
  const membersByCommittee = new Map<string, any[]>();
  for (const m of memberships) {
    if (!m.director || m.director.status !== 'active') continue;
    (membersByCommittee.get(m.committee_id) || membersByCommittee.set(m.committee_id, []).get(m.committee_id)!).push(m);
  }
  const committeesOut = committees.filter((c) => c.is_active !== false).map((c) => {
    const mem = membersByCommittee.get(c.id) || [];
    const chair = mem.find((m) => m.is_chair);
    const independent = mem.filter((m) => m.director?.is_independent).length;
    return {
      id: c.id, name: c.name, isMainBoard: !!c.is_main_board, members: mem.length,
      chair: chair?.director?.full_name || null, independent,
      independentPct: mem.length > 0 ? Math.round((independent / mem.length) * 100) : null,
    };
  }).sort((a, b) => (Number(b.isMainBoard) - Number(a.isMainBoard)) || a.name.localeCompare(b.name));

  // ---- Milestones ----
  const milestones: GovernanceDashboard['milestones'] = [];
  for (const m of (futureRes.data || [])) {
    const d = new Date(m.scheduled_start);
    milestones.push({ date: m.scheduled_start, days: daysUntil(d, now), kind: 'meeting', label: m.title, detail: m.meeting_type === 'committee' && m.committee_id ? (committeeName.get(m.committee_id) || 'Committee') : 'Board' });
  }
  for (const d of outstandingAll) {
    if (d.due_date && new Date(d.due_date).getTime() >= now.getTime()) {
      milestones.push({ date: d.due_date, days: daysUntil(new Date(d.due_date), now), kind: 'declaration_due', label: `${declarationLabel(d.declaration_type)} due`, detail: (d as any).director?.full_name || null });
    }
  }
  for (const d of activeDirectors) {
    if (d.term_end_date && new Date(d.term_end_date).getTime() >= now.getTime()) {
      milestones.push({ date: d.term_end_date, days: daysUntil(new Date(d.term_end_date), now), kind: 'term_end', label: `Term ends — ${d.full_name}`, detail: null });
    }
    if (d.appointed_date) {
      const limitDate = addYears(d.appointed_date, tenureLimitYears);
      if (limitDate.getTime() >= now.getTime()) {
        milestones.push({ date: limitDate.toISOString(), days: daysUntil(limitDate, now), kind: 'tenure_limit', label: `${tenureLimitYears}-year tenure — ${d.full_name}`, detail: 'Independence review' });
      }
    }
  }
  milestones.sort((a, b) => a.date.localeCompare(b.date));

  return {
    year,
    generatedAt: now.toISOString(),
    tenureLimitYears,
    kpis: {
      activeDirectors: activeDirectors.length,
      attendanceRate: overallRate,
      meetingsHeld: heldMeetings.length,
      meetingsScheduled: meetings.filter((m) => m.status === 'scheduled').length,
      outstandingDeclarations: outstandingAll.length,
      overdueDeclarations: outstanding.filter((o) => o.overdue).length,
      committees: committeesOut.length,
      tenureAlerts,
    },
    attendance: { overallRate, byMeeting, byCommittee, byDirector },
    tenure: { limitYears: tenureLimitYears, distribution: Object.entries(buckets).map(([bucket, count]) => ({ bucket, count })), directors: tenureDirectors },
    declarations: { completionRate, byType, outstanding },
    committees: committeesOut,
    milestones: milestones.slice(0, 20),
  };
}
