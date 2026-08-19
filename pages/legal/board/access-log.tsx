import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]';
import { AppLayout } from '../../../components/layout';
import { Card, Button } from '../../../components/ui';
import Loader from '@/components/Loader';
import { useToast } from '../../../components/ui/ToastProvider';
import { useRBAC, useRequirePermission } from '../../../contexts/RBACContext';
import { accessEventLabel, ACCESS_EVENT_LABELS } from '@/lib/directorPortal';
import { ShieldCheck, Save, Filter, ExternalLink, Lock } from 'lucide-react';

function fmtDateTime(iso: string) {
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; }
}

export default function AccessLogPage() {
  const { hasPermission } = useRBAC();
  useRequirePermission(['bgm.portal.view', 'bgm.portal.manage', 'legal.access']);
  const canManage = hasPermission('bgm.portal.manage');
  const { addToast } = useToast();

  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [days, setDays] = useState<number>(7);
  const [savingDays, setSavingDays] = useState(false);
  const [portalUrl, setPortalUrl] = useState('');

  const load = useCallback(async () => {
    const [er, sr] = await Promise.all([
      fetch('/api/legal/bgm/access-events?limit=300'),
      fetch('/api/legal/bgm/portal-settings'),
    ]);
    if (er.ok) setEvents((await er.json()).events || []);
    if (sr.ok) setDays((await sr.json()).default_days || 7);
    setLoading(false);
  }, []);

  useEffect(() => { load(); setPortalUrl(`${window.location.origin}/board-portal/login`); }, [load]);

  const saveDays = async () => {
    setSavingDays(true);
    try {
      const r = await fetch('/api/legal/bgm/portal-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save.');
      addToast({ type: 'success', message: 'Default link lifetime updated.' });
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setSavingDays(false); }
  };

  const filtered = useMemo(() => filter === 'all' ? events : events.filter((e) => e.event_type === filter), [events, filter]);
  const eventTypes = useMemo(() => Array.from(new Set(events.map((e) => e.event_type))), [events]);

  return (
    <AppLayout title="Director Portal Access">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">
            <Link href="/legal" className="hover:underline">Legal</Link> ·{' '}
            <Link href="/legal/board" className="hover:underline">Board Governance</Link> · Portal Access
          </p>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">Director Portal &amp; Secure Links</h1>
          <p className="mt-1 text-sm text-text-secondary max-w-2xl">
            The immutable audit trail of every director portal sign-in and secure-link access, and the configurable link lifetime.
          </p>
        </div>

        {/* Settings + portal entry */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <Card variant="default" padding="lg">
            <div className="flex items-center gap-2 mb-2"><ShieldCheck className="w-4 h-4 text-primary-500" /><h2 className="text-sm font-semibold text-text-primary">Link lifetime</h2></div>
            <p className="text-xs text-neutral-500 mb-3">Default validity for new secure director links. Individual links are single-use.</p>
            <div className="flex items-center gap-2">
              <input type="number" min={1} max={90} value={days} disabled={!canManage}
                onChange={(e) => setDays(parseInt(e.target.value, 10) || 7)}
                className="w-24 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-neutral-50" />
              <span className="text-sm text-neutral-500">days</span>
              {canManage && <Button variant="outline" size="sm" onClick={saveDays} isLoading={savingDays} className="ml-auto"><Save className="w-4 h-4 mr-1.5" /> Save</Button>}
            </div>
          </Card>
          <Card variant="default" padding="lg">
            <div className="flex items-center gap-2 mb-2"><Lock className="w-4 h-4 text-primary-500" /><h2 className="text-sm font-semibold text-text-primary">Portal sign-in</h2></div>
            <p className="text-xs text-neutral-500 mb-3">Directors sign in passwordlessly with an emailed magic link at:</p>
            <a href="/board-portal/login" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:underline break-all">
              <ExternalLink className="w-4 h-4 shrink-0" /> {portalUrl}
            </a>
          </Card>
        </div>

        {/* Audit trail */}
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-neutral-400" />
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-brand-500">
            <option value="all">All events</option>
            {eventTypes.map((t) => <option key={t} value={t}>{ACCESS_EVENT_LABELS[t] || t}</option>)}
          </select>
          <span className="text-xs text-neutral-400">{filtered.length} event(s)</span>
        </div>

        {loading ? (
          <div className="py-16 flex justify-center"><Loader /></div>
        ) : filtered.length === 0 ? (
          <Card variant="default" padding="lg" className="text-center text-sm text-neutral-500">No access events recorded yet.</Card>
        ) : (
          <Card variant="default" padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-neutral-400 border-b border-border">
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">When</th>
                    <th className="px-4 py-3 font-semibold">Director</th>
                    <th className="px-4 py-3 font-semibold">Event</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id} className="border-b border-border/60 hover:bg-neutral-50">
                      <td className="px-4 py-2.5 text-neutral-500 whitespace-nowrap">{fmtDateTime(e.created_at)}</td>
                      <td className="px-4 py-2.5">
                        {e.director?.id
                          ? <Link href={`/legal/board/directors/${e.director.id}`} className="text-text-primary hover:text-primary-600">{e.director.full_name}</Link>
                          : <span className="text-neutral-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`font-medium ${eventTone(e.event_type)}`}>{accessEventLabel(e.event_type)}</span>
                        {e.detail && <span className="text-neutral-400"> · {e.detail}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-400 whitespace-nowrap">{e.ip || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}

function eventTone(t: string): string {
  if (['token_completed', 'login', 'attendance_confirmed', 'declaration_signed', 'profile_updated'].includes(t)) return 'text-emerald-600';
  if (['token_expired', 'token_invalid', 'token_revoked', 'denied', 'session_expired'].includes(t)) return 'text-rose-600';
  return 'text-neutral-700';
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
