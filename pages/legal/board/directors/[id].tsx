import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { requireBgmSSR, buildDirectorDetail, buildCommitteesList, jsonSafe } from '@/lib/bgmSSR';
import { AppLayout } from '../../../../components/layout';
import { Card, Button, Input } from '../../../../components/ui';
import Loader from '@/components/Loader';
import { useToast } from '../../../../components/ui/ToastProvider';
import { useRBAC, useRequirePermission } from '../../../../contexts/RBACContext';
import AttendanceBadge from '../../../../components/legal/bgm/AttendanceBadge';
import { ATTENDANCE_LABELS, ATTENDANCE_STATUSES } from '@/lib/bgm';
import { ArrowLeft, Crown, Mail, Phone, Pencil, Ban, RotateCcw } from 'lucide-react';

const formFromDirector = (d: any) => ({
  email: d?.email || '', phone: d?.phone || '', appointed_date: d?.appointed_date || '', term_end_date: d?.term_end_date || '',
  // '' = auto-detect (null), 'yes' = staff/HRIMS, 'no' = external.
  is_hrims: d?.is_hrims === true ? 'yes' : d?.is_hrims === false ? 'no' : '',
});

interface DirectorProps { initial: any; initialCommittees: any[] }

export default function DirectorDetail({ initial, initialCommittees }: DirectorProps) {
  const router = useRouter();
  const { id } = router.query;
  const { addToast } = useToast();
  const { hasPermission } = useRBAC();
  useRequirePermission(['bgm.directors.view', 'bgm.attendance.view', 'legal.access']);
  const canManage = hasPermission('bgm.directors.manage');

  const [data, setData] = useState<any>(initial);
  const [allCommittees, setAllCommittees] = useState<any[]>(initialCommittees || []);
  const [loading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<any>(() => formFromDirector(initial?.director));
  const [saving, setSaving] = useState(false);

  // Client refetch after a mutation (edit, status change, committee change).
  const load = async () => {
    if (!id) return;
    const [r, cr] = await Promise.all([
      fetch(`/api/legal/bgm/directors/${id}`),
      fetch('/api/legal/bgm/committees'),
    ]);
    if (r.ok) {
      const d = await r.json();
      setData(d);
      setForm(formFromDirector(d.director));
    }
    if (cr.ok) setAllCommittees((await cr.json()).committees || []);
  };

  // SSR provides the data; re-sync when navigating between director ids.
  useEffect(() => {
    setData(initial);
    setAllCommittees(initialCommittees || []);
    setForm(formFromDirector(initial?.director));
  }, [initial, initialCommittees]);

  const setStatus = async (status: string) => {
    const res = await fetch(`/api/legal/bgm/directors/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    });
    if (res.ok) { addToast({ type: 'success', message: `Director marked ${status}.` }); load(); }
    else addToast({ type: 'error', message: 'Failed to update status.' });
  };

  // Optimistic committee toggle: update the UI immediately, then persist. The
  // register/detail is already in state (SSR), so there's no need to refetch on
  // every click — that round-trip is what made the checkboxes feel sluggish.
  const setMembership = async (committeeId: string, member: boolean, isChair = false) => {
    const prev = data;
    const committee = allCommittees.find((c: any) => c.id === committeeId);
    setData((d: any) => {
      if (!d) return d;
      let committees = d.committees || [];
      if (member) {
        committees = committees.some((c: any) => c.id === committeeId)
          ? committees.map((c: any) => (c.id === committeeId ? { ...c, is_chair: isChair } : c))
          : [...committees, { id: committeeId, name: committee?.name, slug: committee?.slug, is_chair: isChair }];
      } else {
        committees = committees.filter((c: any) => c.id !== committeeId);
      }
      return { ...d, committees };
    });
    const res = member
      ? await fetch(`/api/legal/bgm/directors/${id}/committees`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ committee_id: committeeId, is_chair: isChair }) })
      : await fetch(`/api/legal/bgm/directors/${id}/committees?committee_id=${committeeId}`, { method: 'DELETE' });
    if (!res.ok) { setData(prev); addToast({ type: 'error', message: 'Failed to update committee.' }); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/legal/bgm/directors/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email, phone: form.phone, appointed_date: form.appointed_date, term_end_date: form.term_end_date,
          is_hrims: form.is_hrims === 'yes' ? true : form.is_hrims === 'no' ? false : null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save');
      addToast({ type: 'success', message: 'Director updated.' });
      setEditing(false);
      load();
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <AppLayout title="Director"><div className="py-24 flex justify-center"><Loader /></div></AppLayout>;
  if (!data) return <AppLayout title="Director"><div className="max-w-3xl mx-auto p-8 text-center text-neutral-500">Director not found.</div></AppLayout>;

  const { director, committees, history, summary } = data;

  return (
    <AppLayout title={director.full_name}>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/legal/board" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Board Governance
        </Link>

        {/* Profile */}
        <Card variant="default" padding="lg" className="mb-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-text-primary">{director.full_name}</h1>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${director.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>
                {director.status}
              </span>
            </div>
            {canManage && !editing && (
              <div className="flex items-center gap-2">
                {director.status === 'active' ? (
                  <Button variant="outline" onClick={() => setStatus('suspended')}><Ban className="w-4 h-4 mr-1.5" /> Disable</Button>
                ) : (
                  <Button variant="outline" onClick={() => setStatus('active')}><RotateCcw className="w-4 h-4 mr-1.5" /> Re-activate</Button>
                )}
                <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="w-4 h-4 mr-1.5" /> Edit</Button>
              </div>
            )}
          </div>

          {editing ? (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <Input label="Appointed" type="date" value={form.appointed_date} onChange={(e) => setForm({ ...form, appointed_date: e.target.value })} />
              <Input label="Term ends" type="date" value={form.term_end_date} onChange={(e) => setForm({ ...form, term_end_date: e.target.value })} />
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Membership type</label>
                <select value={form.is_hrims} onChange={(e) => setForm({ ...form, is_hrims: e.target.value })}
                  className="w-full px-3 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="">Auto-detect (by email)</option>
                  <option value="yes">Staff / HRIMS member</option>
                  <option value="no">External board member</option>
                </select>
                <p className="text-xs text-gray-400 mt-1">External members must accept the governance terms before signing for attendance.</p>
              </div>
              <div className="sm:col-span-2 flex justify-end gap-2 mt-1">
                <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
                <Button variant="primary" onClick={save} isLoading={saving}>Save</Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-neutral-600">
              <span className="inline-flex items-center gap-1.5"><Mail className="w-4 h-4 text-neutral-400" /> {director.email || 'No email on file'}</span>
              {director.phone && <span className="inline-flex items-center gap-1.5"><Phone className="w-4 h-4 text-neutral-400" /> {director.phone}</span>}
              {director.appointed_date && <span>Appointed {new Date(director.appointed_date).toLocaleDateString()}</span>}
            </div>
          )}

          {/* Committees */}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {committees.length === 0 && <span className="text-xs text-neutral-400">Not on any committee</span>}
            {committees.map((c: any) => (
              <span key={c.id} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-neutral-100 text-neutral-700">
                {c.is_chair && <Crown className="w-3 h-3 text-amber-500" />}
                {c.name}{c.is_chair && ' (Chair)'}
              </span>
            ))}
          </div>
        </Card>

        {/* Committee membership editor */}
        {canManage && (
          <Card variant="default" padding="lg" className="mb-6">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Committee memberships</h2>
            <div className="divide-y divide-border">
              {allCommittees.map((c: any) => {
                const membership = committees.find((m: any) => m.id === c.id);
                const isMember = !!membership;
                return (
                  <div key={c.id} className="flex items-center justify-between py-2.5">
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={isMember} onChange={(e) => setMembership(c.id, e.target.checked, false)}
                        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                      <span className="text-sm text-gray-800">{c.name}</span>
                    </label>
                    {isMember && (
                      <button onClick={() => setMembership(c.id, true, !membership.is_chair)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${membership.is_chair ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-gray-200 text-neutral-500 hover:bg-neutral-50'}`}>
                        <Crown className="w-3 h-3" /> {membership.is_chair ? 'Chair' : 'Make chair'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Cumulative attendance (BGM-02) */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          <StatCard label="Attendance" value={summary.rate === null ? '—' : `${summary.rate}%`} accent />
          {ATTENDANCE_STATUSES.map((s) => (
            <StatCard key={s} label={ATTENDANCE_LABELS[s]} value={summary.counts[s] || 0} />
          ))}
        </div>

        <h2 className="text-lg font-semibold text-text-primary mb-3">Meeting history</h2>
        <Card variant="default" padding="none" className="overflow-hidden">
          <div className="divide-y divide-border">
            {history.length === 0 && <div className="px-4 py-8 text-center text-sm text-neutral-500">No meeting history yet.</div>}
            {history.map((h: any) => (
              <Link key={h.meeting_id} href={`/legal/board/meetings/${h.meeting_id}`}>
                <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50">
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary truncate">{h.meeting_title}</p>
                    <p className="text-xs text-neutral-500">{new Date(h.scheduled_start).toLocaleDateString()} · {h.meeting_type === 'committee' ? 'Committee' : 'Board'}</p>
                  </div>
                  <AttendanceBadge status={h.status} />
                </div>
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </AppLayout>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <Card variant="default" padding="md" className="text-center">
      <p className={`text-2xl font-bold ${accent ? 'text-primary-600' : 'text-text-primary'}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-neutral-400 mt-0.5">{label}</p>
    </Card>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const gate = await requireBgmSSR(context, ['bgm.directors.view', 'bgm.attendance.view', 'legal.access']);
  if ('redirect' in gate) return { redirect: gate.redirect };
  const id = String(context.params?.id || '');
  const [detail, committees] = await Promise.all([
    buildDirectorDetail(gate.ctx.organizationId, id),
    buildCommitteesList(gate.ctx.organizationId),
  ]);
  if (!detail) return { notFound: true };
  return { props: { initial: jsonSafe(detail), initialCommittees: jsonSafe(committees) } };
};
