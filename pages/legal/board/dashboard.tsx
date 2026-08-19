import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]';
import { AppLayout } from '../../../components/layout';
import { Card } from '../../../components/ui';
import Loader from '@/components/Loader';
import { useRequirePermission } from '../../../contexts/RBACContext';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, LineChart, Line,
} from 'recharts';
import {
  Users, ClipboardCheck, CalendarDays, FileWarning, AlarmClock, Landmark, TimerReset,
  FileSpreadsheet, FileText, TrendingUp, Crown, ShieldCheck, AlertTriangle, Gavel, ChevronRight,
} from 'lucide-react';

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso)); } catch { return '—'; }
}

const RATE_COLOR = (r: number | null) => (r === null ? '#d1d5db' : r >= 75 ? '#059669' : r >= 50 ? '#d97706' : '#e11d48');

export default function GovernanceDashboard() {
  useRequirePermission(['bgm.reports.view', 'legal.access']);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);

  const load = useCallback(async (y: number) => {
    setLoading(true);
    const r = await fetch(`/api/legal/bgm/dashboard?year=${y}`);
    if (r.ok) setData(await r.json());
    setLoading(false);
  }, []);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => { load(year); }, [year, load]);

  const years = useMemo(() => { const n = new Date().getFullYear(); return [n - 1, n, n + 1]; }, []);
  const exportUrl = (format: 'pdf' | 'xlsx') => `/api/legal/bgm/dashboard/export?format=${format}&year=${year}`;

  const k = data?.kpis;

  return (
    <AppLayout title="Governance Dashboard">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">
              <Link href="/legal" className="hover:underline">Legal</Link> ·{' '}
              <Link href="/legal/board" className="hover:underline">Board Governance</Link> · Dashboard
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">Governance Reporting Dashboard</h1>
            <p className="mt-1 text-sm text-text-secondary max-w-2xl">Real-time board governance metrics for the legal team and board leadership.</p>
          </div>
          <div className="flex items-center gap-2">
            <a href={exportUrl('pdf')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-neutral-700 hover:bg-neutral-50 min-h-[40px]">
              <FileText className="w-4 h-4" /> PDF
            </a>
            <a href={exportUrl('xlsx')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-neutral-700 hover:bg-neutral-50 min-h-[40px]">
              <FileSpreadsheet className="w-4 h-4" /> Excel
            </a>
          </div>
        </div>

        {/* Year selector */}
        <div className="flex items-center gap-2 mb-6">
          {years.map((y) => (
            <button key={y} onClick={() => setYear(y)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${y === year ? 'bg-primary-600 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}>{y}</button>
          ))}
          {data && <span className="ml-2 text-xs text-neutral-400">Updated {new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' } as any)}</span>}
        </div>

        {loading || !data ? (
          <div className="py-24 flex justify-center"><Loader /></div>
        ) : (
          <div className="space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi icon={<Users className="w-4 h-4" />} label="Active directors" value={k.activeDirectors} />
              <Kpi icon={<ClipboardCheck className="w-4 h-4" />} label="Attendance rate" value={k.attendanceRate === null ? '—' : `${k.attendanceRate}%`} tone={k.attendanceRate === null ? undefined : k.attendanceRate >= 75 ? 'emerald' : k.attendanceRate >= 50 ? 'amber' : 'rose'} />
              <Kpi icon={<CalendarDays className="w-4 h-4" />} label="Meetings held" value={k.meetingsHeld} sub={`${k.meetingsScheduled} scheduled`} />
              <Kpi icon={<FileWarning className="w-4 h-4" />} label="Outstanding declarations" value={k.outstandingDeclarations} sub={k.overdueDeclarations > 0 ? `${k.overdueDeclarations} overdue` : undefined} tone={k.overdueDeclarations > 0 ? 'rose' : undefined} />
              <Kpi icon={<Landmark className="w-4 h-4" />} label="Committees" value={k.committees} />
              <Kpi icon={<AlarmClock className="w-4 h-4" />} label="Tenure alerts" value={k.tenureAlerts} tone={k.tenureAlerts > 0 ? 'amber' : undefined} />
              <Kpi icon={<TrendingUp className="w-4 h-4" />} label="Declaration completion" value={data.declarations.completionRate === null ? '—' : `${data.declarations.completionRate}%`} />
              <Kpi icon={<TimerReset className="w-4 h-4" />} label="Tenure limit" value={`${data.tenure.limitYears}y`} />
            </div>

            {/* Attendance */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Panel title="Attendance rate by meeting" className="lg:col-span-2" icon={<ClipboardCheck className="w-4 h-4" />}>
                {data.attendance.byMeeting.length === 0 ? <Empty label="No meetings this year." /> : mounted && (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={data.attendance.byMeeting.map((m: any, i: number) => ({ name: `M${i + 1}`, title: m.title, rate: m.rate }))} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f1f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#9ca3af' }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                      <Tooltip formatter={(v: any) => [`${v}%`, 'Attendance']} labelFormatter={(_, p: any) => p?.[0]?.payload?.title || ''} />
                      <Line type="monotone" dataKey="rate" stroke="#9A7545" strokeWidth={2} dot={{ r: 3, fill: '#9A7545' }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </Panel>
              <Panel title="Attendance by group" icon={<Landmark className="w-4 h-4" />}>
                {data.attendance.byCommittee.length === 0 ? <Empty label="No data." /> : (
                  <div className="space-y-3">
                    {data.attendance.byCommittee.map((c: any) => (
                      <div key={c.name}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-neutral-700 truncate">{c.name}</span>
                          <span className="font-semibold" style={{ color: RATE_COLOR(c.rate) }}>{c.rate === null ? '—' : `${c.rate}%`}</span>
                        </div>
                        <div className="h-2 rounded-full bg-neutral-100 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${c.rate ?? 0}%`, backgroundColor: RATE_COLOR(c.rate) }} />
                        </div>
                        <p className="text-[11px] text-neutral-400 mt-0.5">{c.meetings} meeting(s)</p>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            {/* Tenure + Declarations */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Panel title="Director tenure" icon={<TimerReset className="w-4 h-4" />} action={<Link href="/legal/board" className="text-xs text-primary-600 hover:underline">Directors</Link>}>
                {mounted && (
                  <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={data.tenure.distribution} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f1f0" vertical={false} />
                      <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: '#9ca3af' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                      <Tooltip formatter={(v: any) => [v, 'Directors']} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {data.tenure.distribution.map((b: any, i: number) => <Cell key={i} fill={b.bucket === '9y+' ? '#e11d48' : b.bucket === '6–9y' ? '#d97706' : '#9A7545'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
                <div className="mt-3 space-y-1.5">
                  {data.tenure.directors.filter((t: any) => t.status === 'over' || t.status === 'approaching').slice(0, 5).map((t: any) => (
                    <div key={t.id} className="flex items-center gap-2 text-sm">
                      <AlertTriangle className={`w-4 h-4 shrink-0 ${t.status === 'over' ? 'text-rose-500' : 'text-amber-500'}`} />
                      <Link href={`/legal/board/directors/${t.id}`} className="text-neutral-700 hover:text-primary-600 flex-1 truncate">{t.name}</Link>
                      <span className="text-xs text-neutral-500">{t.years ?? '—'}y{t.status === 'over' ? ' · over limit' : ' · approaching'}</span>
                    </div>
                  ))}
                  {data.tenure.directors.filter((t: any) => t.status === 'over' || t.status === 'approaching').length === 0 && (
                    <p className="text-sm text-emerald-600 inline-flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" /> All directors within tenure limits.</p>
                  )}
                </div>
              </Panel>

              <Panel title="Declarations" icon={<FileWarning className="w-4 h-4" />} action={<Link href="/legal/board/declarations" className="text-xs text-primary-600 hover:underline">Manage</Link>}>
                <div className="space-y-2 mb-3">
                  {data.declarations.byType.map((t: any) => {
                    const total = t.issued + t.submitted;
                    const pct = total > 0 ? Math.round((t.submitted / total) * 100) : null;
                    return (
                      <div key={t.type}>
                        <div className="flex items-center justify-between text-sm mb-0.5">
                          <span className="text-neutral-700 truncate">{t.label}</span>
                          <span className="text-xs text-neutral-500">{t.submitted}/{total || 0}{t.issued > 0 ? ` · ${t.issued} outstanding` : ''}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct ?? 0}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {data.declarations.outstanding.length > 0 && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1.5">Outstanding</p>
                    <div className="space-y-1">
                      {data.declarations.outstanding.slice(0, 5).map((o: any) => (
                        <div key={o.id} className="flex items-center gap-2 text-sm">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${o.overdue ? 'bg-rose-500' : 'bg-amber-400'}`} />
                          <span className="text-neutral-700 truncate flex-1">{o.director}</span>
                          <span className="text-xs text-neutral-400 truncate">{o.label}</span>
                          {o.due && <span className={`text-xs ${o.overdue ? 'text-rose-600 font-medium' : 'text-neutral-400'}`}>{fmtDate(o.due)}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Panel>
            </div>

            {/* Committees */}
            <Panel title="Committee compositions" icon={<Landmark className="w-4 h-4" />}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.committees.map((c: any) => (
                  <div key={c.id} className="rounded-xl border border-border p-3.5">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-text-primary text-sm truncate">{c.name}</p>
                      {c.isMainBoard && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-xs text-neutral-500">
                      <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {c.members}</span>
                      {c.independentPct !== null && <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> {c.independentPct}% indep.</span>}
                    </div>
                    <p className="mt-1.5 text-xs text-neutral-400 truncate">Chair: {c.chair || '—'}</p>
                  </div>
                ))}
              </div>
            </Panel>

            {/* Milestones */}
            <Panel title="Upcoming governance milestones" icon={<CalendarDays className="w-4 h-4" />}>
              {data.milestones.length === 0 ? <Empty label="No upcoming milestones." /> : (
                <div className="divide-y divide-border">
                  {data.milestones.map((m: any, i: number) => (
                    <div key={i} className="flex items-center gap-3 py-2.5">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${milestoneStyle(m.kind).bg}`}>{milestoneStyle(m.kind).icon}</div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-primary truncate">{m.label}</p>
                        {m.detail && <p className="text-xs text-neutral-400 truncate">{m.detail}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm text-neutral-700">{fmtDate(m.date)}</p>
                        <p className={`text-[11px] ${m.days <= 7 ? 'text-rose-600' : m.days <= 30 ? 'text-amber-600' : 'text-neutral-400'}`}>in {m.days} day{m.days === 1 ? '' : 's'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function Kpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string | number; sub?: string; tone?: 'emerald' | 'amber' | 'rose' }) {
  const toneCls = tone === 'emerald' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : tone === 'rose' ? 'text-rose-600' : 'text-text-primary';
  return (
    <Card variant="default" padding="md">
      <div className="flex items-center gap-1.5 text-neutral-400">{icon}<span className="text-[11px] uppercase tracking-wider font-semibold">{label}</span></div>
      <p className={`mt-1 text-2xl font-bold ${toneCls}`}>{value}</p>
      {sub && <p className="text-[11px] text-neutral-400 mt-0.5">{sub}</p>}
    </Card>
  );
}

function Panel({ title, icon, action, children, className = '' }: { title: string; icon?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card variant="default" padding="lg" className={className}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary inline-flex items-center gap-1.5">{icon && <span className="text-primary-500">{icon}</span>}{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Empty({ label }: { label: string }) { return <p className="text-sm text-neutral-400 py-6 text-center">{label}</p>; }

function milestoneStyle(kind: string): { bg: string; icon: React.ReactNode } {
  switch (kind) {
    case 'meeting': return { bg: 'bg-sky-50 text-sky-600', icon: <CalendarDays className="w-4 h-4" /> };
    case 'declaration_due': return { bg: 'bg-amber-50 text-amber-600', icon: <FileWarning className="w-4 h-4" /> };
    case 'term_end': return { bg: 'bg-rose-50 text-rose-600', icon: <TimerReset className="w-4 h-4" /> };
    case 'tenure_limit': return { bg: 'bg-primary-50 text-primary-600', icon: <Gavel className="w-4 h-4" /> };
    default: return { bg: 'bg-neutral-100 text-neutral-500', icon: <ChevronRight className="w-4 h-4" /> };
  }
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
