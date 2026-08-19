import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]';
import { AppLayout } from '../../../../components/layout';
import { Card, Button } from '../../../../components/ui';
import Loader from '@/components/Loader';
import IssueDeclarationModal from '../../../../components/legal/bgm/IssueDeclarationModal';
import { useRBAC, useRequirePermission } from '../../../../contexts/RBACContext';
import {
  DECLARATION_LIST, DECLARATION_STATUS_LABELS, DECLARATION_STATUS_STYLES,
  declarationLabel, REGISTER_COLUMNS, DeclarationStatus,
} from '@/lib/bgmDeclarations';
import {
  FileSignature, Plus, Search, ChevronRight, ClipboardList, ScrollText,
  BookOpen, CheckCircle2, Clock,
} from 'lucide-react';

type View = 'declarations' | 'registers';

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso)); } catch { return '—'; }
}

export default function DeclarationsPage() {
  const { hasPermission } = useRBAC();
  useRequirePermission(['bgm.declarations.view', 'legal.access']);
  const canManage = hasPermission('bgm.declarations.manage');

  const [view, setView] = useState<View>('declarations');
  const [loading, setLoading] = useState(true);
  const [declarations, setDeclarations] = useState<any[]>([]);
  const [directors, setDirectors] = useState<any[]>([]);
  const [registers, setRegisters] = useState<{ interests: any[]; related_party: any[] }>({ interests: [], related_party: [] });
  const [issueOpen, setIssueOpen] = useState(false);

  // filters
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [searchQ, setSearchQ] = useState('');
  const [registerTab, setRegisterTab] = useState<'interests' | 'related_party'>('interests');

  const load = useCallback(async () => {
    setLoading(true);
    const [dr, dirs, reg] = await Promise.all([
      fetch('/api/legal/bgm/declarations'),
      fetch('/api/legal/bgm/directors'),
      fetch('/api/legal/bgm/registers'),
    ]);
    if (dr.ok) setDeclarations((await dr.json()).declarations || []);
    if (dirs.ok) setDirectors((await dirs.json()).directors || []);
    if (reg.ok) setRegisters(await reg.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    return declarations.filter((d) => {
      if (filterType !== 'all' && d.declaration_type !== filterType) return false;
      if (filterStatus !== 'all' && d.status !== filterStatus) return false;
      if (q && !(`${d.director?.full_name || ''} ${declarationLabel(d.declaration_type)}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [declarations, filterType, filterStatus, searchQ]);

  const stats = useMemo(() => {
    const s = { total: declarations.length, issued: 0, submitted: 0, draft: 0 };
    for (const d of declarations) {
      if (d.status === 'issued') s.issued++;
      else if (d.status === 'submitted') s.submitted++;
      else if (d.status === 'draft') s.draft++;
    }
    return s;
  }, [declarations]);

  return (
    <AppLayout title="Governance Declarations">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">
              <Link href="/legal" className="hover:underline">Legal</Link> ·{' '}
              <Link href="/legal/board" className="hover:underline">Board Governance</Link> · Declarations
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">Governance Declarations</h1>
            <p className="mt-1 text-sm text-text-secondary max-w-2xl">
              Digital, e-signed director declarations. Submissions auto-populate the governance registers and director profiles.
            </p>
          </div>
          {canManage && (
            <Button variant="primary" onClick={() => setIssueOpen(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Issue declaration
            </Button>
          )}
        </div>

        {/* Section tabs */}
        <div className="flex gap-1 border-b border-border mb-6">
          {([['declarations', 'Declarations', <ClipboardList key="i" className="w-4 h-4" />], ['registers', 'Governance Registers', <BookOpen key="r" className="w-4 h-4" />]] as [View, string, React.ReactNode][]).map(([k, label, icon]) => (
            <button key={k} onClick={() => setView(k)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${view === k ? 'border-primary-500 text-primary-700' : 'border-transparent text-neutral-500 hover:text-neutral-800'}`}>
              {icon}{label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="py-20 flex justify-center"><Loader /></div>
        ) : view === 'declarations' ? (
          <>
            {/* Stat strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <Stat icon={<ScrollText className="w-4 h-4" />} label="Total" value={stats.total} />
              <Stat icon={<Clock className="w-4 h-4" />} label="Awaiting director" value={stats.issued} tone="amber" />
              <Stat icon={<CheckCircle2 className="w-4 h-4" />} label="Submitted" value={stats.submitted} tone="emerald" />
              <Stat icon={<FileSignature className="w-4 h-4" />} label="Drafts" value={stats.draft} />
            </div>

            {/* Filters */}
            <Card variant="default" padding="sm" className="mb-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search by director or type…"
                    className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </div>
                <select value={filterType} onChange={(e) => setFilterType(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="all">All types</option>
                  {DECLARATION_LIST.map((d) => <option key={d.type} value={d.type}>{d.shortLabel}</option>)}
                </select>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="all">Any status</option>
                  {(Object.keys(DECLARATION_STATUS_LABELS) as DeclarationStatus[]).map((s) => <option key={s} value={s}>{DECLARATION_STATUS_LABELS[s]}</option>)}
                </select>
              </div>
            </Card>

            {filtered.length === 0 ? (
              <Card variant="default" padding="lg" className="text-center">
                <ClipboardList className="w-10 h-10 text-neutral-300 mx-auto mb-2" />
                <p className="text-sm text-neutral-500">{declarations.length === 0 ? 'No declarations issued yet.' : 'No declarations match these filters.'}</p>
                {canManage && declarations.length === 0 && (
                  <Button variant="outline" className="mt-3" onClick={() => setIssueOpen(true)}><Plus className="w-4 h-4 mr-1.5" /> Issue the first declaration</Button>
                )}
              </Card>
            ) : (
              <Card variant="default" padding="none" className="overflow-hidden">
                <div className="divide-y divide-border">
                  {filtered.map((d) => (
                    <Link key={d.id} href={`/legal/board/declarations/${d.id}`}>
                      <div className="flex items-center gap-3 px-4 py-3 hover:bg-neutral-50 transition-colors">
                        <div className="w-9 h-9 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center shrink-0">
                          <FileSignature className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-text-primary truncate">{d.director?.full_name || 'Director'}</p>
                          <p className="text-xs text-neutral-500 truncate">
                            {declarationLabel(d.declaration_type)}{d.period_year ? ` · ${d.period_year}` : ''}
                            {d.status === 'submitted' && d.submitted_at ? ` · signed ${fmtDate(d.submitted_at)}` : d.due_date ? ` · due ${fmtDate(d.due_date)}` : ''}
                          </p>
                        </div>
                        <StatusBadge status={d.status} />
                        <ChevronRight className="w-4 h-4 text-neutral-300 shrink-0" />
                      </div>
                    </Link>
                  ))}
                </div>
              </Card>
            )}
          </>
        ) : (
          /* ---- Registers ---- */
          <>
            <div className="flex gap-1 mb-4">
              {([['interests', 'Register of Interests'], ['related_party', 'Related-Party Register']] as ['interests' | 'related_party', string][]).map(([k, label]) => (
                <button key={k} onClick={() => setRegisterTab(k)}
                  className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${registerTab === k ? 'bg-primary-600 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}>
                  {label}
                </button>
              ))}
            </div>
            <RegisterTable rows={registers[registerTab]} columns={REGISTER_COLUMNS[registerTab]} />
          </>
        )}
      </div>

      <IssueDeclarationModal
        isOpen={issueOpen}
        onClose={() => setIssueOpen(false)}
        directors={directors}
        onIssued={load}
      />
    </AppLayout>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone?: 'amber' | 'emerald' }) {
  const toneCls = tone === 'amber' ? 'text-amber-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-text-primary';
  return (
    <Card variant="default" padding="md">
      <div className="flex items-center gap-1.5 text-neutral-400">{icon}<span className="text-[11px] uppercase tracking-wider font-semibold">{label}</span></div>
      <p className={`mt-1 text-2xl font-bold ${toneCls}`}>{value}</p>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = (DECLARATION_STATUS_STYLES as any)[status] || DECLARATION_STATUS_STYLES.draft;
  const label = (DECLARATION_STATUS_LABELS as any)[status] || status;
  return (
    <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />{label}
    </span>
  );
}

function RegisterTable({ rows, columns }: { rows: any[]; columns: any[] }) {
  // Show up to 4 of the most meaningful columns to keep the table readable.
  const cols = columns.slice(0, 4);
  const withEntries = rows.filter((r) => !r.nil);
  const nilDirectors = rows.filter((r) => r.nil);
  return (
    <div>
      <Card variant="default" padding="none" className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-neutral-400 border-b border-border">
                <th className="px-4 py-3 font-semibold">Director</th>
                {cols.map((c) => <th key={c.key} className="px-4 py-3 font-semibold whitespace-nowrap">{c.label}</th>)}
                <th className="px-4 py-3 font-semibold whitespace-nowrap">Declared</th>
              </tr>
            </thead>
            <tbody>
              {withEntries.length === 0 && (
                <tr><td colSpan={cols.length + 2} className="px-4 py-10 text-center text-sm text-neutral-500">No entries in this register yet.</td></tr>
              )}
              {withEntries.map((r, i) => (
                <tr key={i} className="border-b border-border/60 hover:bg-neutral-50 align-top">
                  <td className="px-4 py-3">
                    {r.director_id
                      ? <Link href={`/legal/board/directors/${r.director_id}`} className="font-medium text-text-primary hover:text-primary-600">{r.director_name}</Link>
                      : <span className="font-medium">{r.director_name}</span>}
                  </td>
                  {cols.map((c) => <td key={c.key} className="px-4 py-3 text-neutral-600">{formatCell(r.fields[c.key])}</td>)}
                  <td className="px-4 py-3 text-neutral-500 whitespace-nowrap">{fmtDate(r.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {nilDirectors.length > 0 && (
        <p className="mt-3 text-xs text-neutral-500">
          Nil declarations: {nilDirectors.map((r) => r.director_name).join(', ')}.
        </p>
      )}
    </div>
  );
}

function formatCell(v: any) {
  if (v === undefined || v === null || v === '') return <span className="text-neutral-300">—</span>;
  return String(v);
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
