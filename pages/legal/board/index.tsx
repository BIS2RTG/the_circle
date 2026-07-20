import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]';
import { getUserRBACProfile, hasAnyPermission } from '@/lib/rbac';
import { AppLayout } from '../../../components/layout';
import { Card, Button } from '../../../components/ui';
import Loader from '@/components/Loader';
import ScheduleMeetingModal from '../../../components/legal/bgm/ScheduleMeetingModal';
import DirectorFormModal from '../../../components/legal/bgm/DirectorFormModal';
import { ATTENDANCE_LABELS, ATTENDANCE_STATUSES } from '@/lib/bgm';
import {
  CalendarDays, ListChecks, ClipboardCheck, Users, Plus, MapPin, Video, Crown, ChevronRight,
} from 'lucide-react';
import { useRBAC } from '../../../contexts/RBACContext';

type Tab = 'calendar' | 'meetings' | 'attendance' | 'directors';

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'calendar', label: 'Calendar', icon: <CalendarDays className="w-4 h-4" /> },
  { key: 'meetings', label: 'Meetings', icon: <ListChecks className="w-4 h-4" /> },
  { key: 'attendance', label: 'Attendance', icon: <ClipboardCheck className="w-4 h-4" /> },
  { key: 'directors', label: 'Directors', icon: <Users className="w-4 h-4" /> },
];

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtDateTime(iso: string, tz?: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
  } catch { return new Date(iso).toLocaleString(); }
}

export default function BoardGovernanceHub() {
  const router = useRouter();
  const { hasPermission } = useRBAC();
  const canManageMeetings = hasPermission('bgm.meetings.manage');
  const canManageDirectors = hasPermission('bgm.directors.manage');

  const [tab, setTab] = useState<Tab>('calendar');
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [directorFormOpen, setDirectorFormOpen] = useState(false);

  const [committees, setCommittees] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [directors, setDirectors] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadCommittees = useCallback(async () => {
    const r = await fetch('/api/legal/bgm/committees');
    if (r.ok) setCommittees((await r.json()).committees || []);
  }, []);

  const loadMeetings = useCallback(async (y: number) => {
    const r = await fetch(`/api/legal/bgm/meetings?year=${y}`);
    if (r.ok) setMeetings((await r.json()).meetings || []);
  }, []);

  const loadDirectors = useCallback(async () => {
    const r = await fetch('/api/legal/bgm/directors');
    if (r.ok) setDirectors((await r.json()).directors || []);
  }, []);

  const loadSummary = useCallback(async () => {
    const r = await fetch('/api/legal/bgm/attendance/summary');
    if (r.ok) setSummary((await r.json()).summary || []);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadCommittees(), loadMeetings(year), loadDirectors(), loadSummary()]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadMeetings(year); }, [year, loadMeetings]);

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return [now - 1, now, now + 1];
  }, []);

  const meetingsByMonth = useMemo(() => {
    const map: Record<number, any[]> = {};
    for (const m of meetings) {
      const mo = new Date(m.scheduled_start).getMonth();
      (map[mo] = map[mo] || []).push(m);
    }
    return map;
  }, [meetings]);

  return (
    <AppLayout title="Board Governance">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">
              <Link href="/legal" className="hover:underline">Legal</Link> · Board Governance
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">
              Board &amp; Committee Administration
            </h1>
          </div>
          {canManageMeetings && (
            <Button variant="primary" onClick={() => setScheduleOpen(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Schedule meeting
            </Button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border mb-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                tab === t.key ? 'border-primary-500 text-primary-700' : 'border-transparent text-neutral-500 hover:text-neutral-800'
              }`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="py-20 flex justify-center"><Loader /></div>
        ) : (
          <>
            {/* ---- Calendar ---- */}
            {tab === 'calendar' && (
              <div>
                <div className="flex items-center gap-2 mb-5">
                  {years.map((y) => (
                    <button
                      key={y}
                      onClick={() => setYear(y)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        y === year ? 'bg-primary-600 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                      }`}
                    >
                      {y}
                    </button>
                  ))}
                  <span className="ml-2 text-sm text-neutral-500">{meetings.length} meeting(s) in {year}</span>
                </div>

                {meetings.length === 0 ? (
                  <EmptyState label={`No meetings scheduled for ${year}.`} />
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {MONTHS.map((mo, i) =>
                      meetingsByMonth[i] ? (
                        <Card key={i} variant="default" padding="md">
                          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">{mo}</p>
                          <div className="space-y-2">
                            {meetingsByMonth[i].map((m) => (
                              <MeetingRow key={m.id} m={m} />
                            ))}
                          </div>
                        </Card>
                      ) : null
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ---- Meetings ---- */}
            {tab === 'meetings' && (
              <div className="space-y-2">
                {meetings.length === 0 ? (
                  <EmptyState label={`No meetings scheduled for ${year}.`} />
                ) : (
                  meetings.map((m) => <MeetingRow key={m.id} m={m} expanded />)
                )}
              </div>
            )}

            {/* ---- Attendance (cumulative per director) ---- */}
            {tab === 'attendance' && (
              <Card variant="default" padding="none" className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-neutral-400 border-b border-border">
                        <th className="px-4 py-3 font-semibold">Director</th>
                        {ATTENDANCE_STATUSES.map((s) => (
                          <th key={s} className="px-3 py-3 font-semibold text-center">{ATTENDANCE_LABELS[s]}</th>
                        ))}
                        <th className="px-4 py-3 font-semibold text-right">Attendance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((row) => (
                        <tr key={row.director.id} className="border-b border-border/60 hover:bg-neutral-50">
                          <td className="px-4 py-3">
                            <Link href={`/legal/board/directors/${row.director.id}`} className="font-medium text-text-primary hover:text-primary-600">
                              {row.director.full_name}
                            </Link>
                          </td>
                          {ATTENDANCE_STATUSES.map((s) => (
                            <td key={s} className="px-3 py-3 text-center text-neutral-600">{row.counts[s] || 0}</td>
                          ))}
                          <td className="px-4 py-3 text-right">
                            {row.rate === null ? (
                              <span className="text-neutral-400">—</span>
                            ) : (
                              <span className={`font-semibold ${row.rate >= 75 ? 'text-emerald-600' : row.rate >= 50 ? 'text-amber-600' : 'text-rose-600'}`}>
                                {row.rate}%
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* ---- Directors ---- */}
            {tab === 'directors' && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm text-neutral-500">{directors.filter((d) => d.status === 'active').length} active · {directors.length} total</span>
                  {canManageDirectors && (
                    <Button variant="primary" onClick={() => setDirectorFormOpen(true)}>
                      <Plus className="w-4 h-4 mr-1.5" /> Add board member
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {directors.map((d) => (
                    <Link key={d.id} href={`/legal/board/directors/${d.id}`}>
                      <Card variant="default" padding="md" className={`h-full hover:shadow-card-hover transition-shadow cursor-pointer ${d.status !== 'active' ? 'opacity-70' : ''}`}>
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-semibold text-text-primary">{d.full_name}</p>
                            <p className="text-xs text-neutral-500 mt-0.5">{d.email || 'No email on file'}</p>
                          </div>
                          {d.status === 'active'
                            ? <ChevronRight className="w-4 h-4 text-neutral-300 shrink-0" />
                            : <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium bg-neutral-100 text-neutral-500 capitalize">{d.status}</span>}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {(d.committees || []).slice(0, 4).map((c: any) => (
                            <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-neutral-100 text-neutral-600">
                              {c.is_chair && <Crown className="w-3 h-3 text-amber-500" />}
                              {c.name}
                            </span>
                          ))}
                        </div>
                      </Card>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <ScheduleMeetingModal
        isOpen={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        committees={committees}
        directors={directors}
        onCreated={(id) => { setScheduleOpen(false); router.push(`/legal/board/meetings/${id}`); }}
      />

      <DirectorFormModal
        isOpen={directorFormOpen}
        onClose={() => setDirectorFormOpen(false)}
        onCreated={() => { setDirectorFormOpen(false); loadDirectors(); }}
      />
    </AppLayout>
  );
}

function MeetingRow({ m, expanded }: { m: any; expanded?: boolean }) {
  const committeeName = m.committee?.name;
  return (
    <Link href={`/legal/board/meetings/${m.id}`}>
      <div className={`group rounded-xl border border-border hover:border-primary-300 hover:bg-primary-50/30 transition-colors ${expanded ? 'p-4' : 'p-2.5'}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-text-primary truncate">{m.title}</p>
            <p className="text-xs text-neutral-500 mt-0.5 truncate">
              {fmtDateTime(m.scheduled_start, m.time_zone)}
              {m.meeting_type === 'committee' && committeeName ? ` · ${committeeName}` : ' · Board'}
            </p>
            {expanded && (
              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-neutral-500">
                {m.is_virtual ? (
                  <span className="inline-flex items-center gap-1"><Video className="w-3.5 h-3.5" /> Virtual</span>
                ) : m.location ? (
                  <span className="inline-flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {m.location}</span>
                ) : null}
                <span>{m.attendance_tally?.recorded || 0}/{m.attendance_tally?.invited || 0} attendance recorded</span>
                {m.invitations_sent_at && <span className="text-emerald-600">Invitations sent</span>}
              </div>
            )}
          </div>
          <StatusPill status={m.status} />
        </div>
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    scheduled: 'bg-sky-50 text-sky-700',
    completed: 'bg-emerald-50 text-emerald-700',
    cancelled: 'bg-neutral-100 text-neutral-500 line-through',
  };
  return <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${map[status] || 'bg-neutral-100'}`}>{status}</span>;
}

function EmptyState({ label }: { label: string }) {
  return (
    <Card variant="default" padding="lg" className="text-center">
      <p className="text-sm text-neutral-500">{label}</p>
    </Card>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) {
    return { redirect: { destination: '/', permanent: false } };
  }
  const profile = await getUserRBACProfile((session.user as any).id);
  if (!hasAnyPermission(profile, ['bgm.meetings.view', 'bgm.directors.view', 'legal.access'])) {
    return { redirect: { destination: '/dashboard', permanent: false } };
  }
  return { props: {} };
};
