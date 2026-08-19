import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]';
import { AppLayout } from '../../../../components/layout';
import { Card, Button } from '../../../../components/ui';
import Loader from '@/components/Loader';
import { useToast } from '../../../../components/ui/ToastProvider';
import ConfirmDialog from '../../../../components/ui/ConfirmDialog';
import CompleteDeclarationModal from '../../../../components/legal/bgm/CompleteDeclarationModal';
import { useRBAC, useRequirePermission } from '../../../../contexts/RBACContext';
import {
  getDeclarationDef, DECLARATION_STATUS_LABELS, DECLARATION_STATUS_STYLES,
  DeclarationDef, FieldDef,
} from '@/lib/bgmDeclarations';
import {
  ArrowLeft, Mail, Copy, PenLine, Ban, Link2, ShieldCheck, CheckCircle2, Clock, Trash2, ExternalLink,
} from 'lucide-react';

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date(iso)); } catch { return '—'; }
}
function fmtDateTime(iso: string | null) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return '—'; }
}

export default function DeclarationDetail() {
  const router = useRouter();
  const { id } = router.query;
  const { addToast } = useToast();
  const { hasPermission } = useRBAC();
  useRequirePermission(['bgm.declarations.view', 'legal.access']);
  const canManage = hasPermission('bgm.declarations.manage');

  const [data, setData] = useState<any>(null);
  const [issuer, setIssuer] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const r = await fetch(`/api/legal/bgm/declarations/${id}`);
    if (r.ok) { const d = await r.json(); setData(d.declaration); setIssuer(d.issuer); }
    else setData(null);
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const remind = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/declarations/${id}/remind`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not send the reminder.');
      addToast({ type: 'success', message: 'Reminder emailed to the director.' });
      load();
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const copyLink = () => {
    if (!data?.access_token) { addToast({ type: 'error', message: 'No active link — send a reminder to generate one.' }); return; }
    const url = `${window.location.origin}/board/declaration/${data.access_token}`;
    navigator.clipboard.writeText(url).then(
      () => addToast({ type: 'success', message: 'Completion link copied.' }),
      () => addToast({ type: 'error', message: 'Could not copy the link.' }),
    );
  };

  const doCancel = async () => {
    setConfirmCancel(false);
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/declarations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Could not cancel.');
      addToast({ type: 'success', message: 'Declaration cancelled.' });
      load();
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/declarations/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || 'Could not delete.');
      addToast({ type: 'success', message: 'Declaration deleted.' });
      router.push('/legal/board/declarations');
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); setBusy(false); }
  };

  if (loading) return <AppLayout title="Declaration"><div className="py-24 flex justify-center"><Loader /></div></AppLayout>;
  if (!data) return <AppLayout title="Declaration"><div className="max-w-3xl mx-auto p-8 text-center text-neutral-500">Declaration not found.</div></AppLayout>;

  const def = getDeclarationDef(data.declaration_type);
  const s = (DECLARATION_STATUS_STYLES as any)[data.status] || DECLARATION_STATUS_STYLES.draft;
  const statusLabel = (DECLARATION_STATUS_LABELS as any)[data.status] || data.status;
  const isSubmitted = data.status === 'submitted';
  const isOutstanding = data.status === 'issued' || data.status === 'draft';

  return (
    <AppLayout title={def?.title || 'Declaration'}>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/legal/board/declarations" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Declarations
        </Link>

        {/* Header card */}
        <Card variant="default" padding="lg" className="mb-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">{def?.shortLabel}</p>
              <h1 className="mt-1 text-xl font-bold text-text-primary">{def?.title}</h1>
              <p className="text-sm text-neutral-500 mt-1">
                <Link href={`/legal/board/directors/${data.director?.id}`} className="font-medium text-text-primary hover:text-primary-600">{data.director?.full_name}</Link>
                {data.period_year ? ` · ${data.period_year} governance year` : ''}
              </p>
            </div>
            <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${s.bg} ${s.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />{statusLabel}
            </span>
          </div>

          {/* Meta grid */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-y-3 gap-x-4 text-sm">
            <Meta label="Issued by" value={issuer?.display_name || '—'} />
            <Meta label="Issued" value={fmtDate(data.issued_at)} />
            <Meta label="Due" value={data.due_date ? fmtDate(data.due_date) : '—'} />
            <Meta label={isSubmitted ? 'Submitted' : 'Reminded'} value={isSubmitted ? fmtDateTime(data.submitted_at) : (data.reminded_at ? fmtDateTime(data.reminded_at) : '—')} />
          </div>

          {/* Actions */}
          {canManage && isOutstanding && (
            <div className="mt-5 pt-4 border-t border-border flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => setCompleteOpen(true)}><PenLine className="w-4 h-4 mr-1.5" /> Complete in person</Button>
              <Button variant="outline" size="sm" onClick={remind} isLoading={busy}><Mail className="w-4 h-4 mr-1.5" /> {data.reminded_at ? 'Resend link' : 'Email link'}</Button>
              <Button variant="outline" size="sm" onClick={copyLink}><Copy className="w-4 h-4 mr-1.5" /> Copy link</Button>
              {data.access_token && (
                <a href={`/board/declaration/${data.access_token}`} target="_blank" rel="noreferrer"
                  className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 min-h-[36px]">
                  <ExternalLink className="w-4 h-4 mr-1.5" /> Open form
                </a>
              )}
              <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(true)} className="text-rose-600 hover:bg-rose-50"><Ban className="w-4 h-4 mr-1.5" /> Cancel</Button>
            </div>
          )}
          {canManage && data.status === 'cancelled' && (
            <div className="mt-5 pt-4 border-t border-border">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} className="text-rose-600 hover:bg-rose-50"><Trash2 className="w-4 h-4 mr-1.5" /> Delete record</Button>
            </div>
          )}
        </Card>

        {/* Outstanding hint */}
        {isOutstanding && (
          <Card variant="default" padding="md" className="mb-6 bg-amber-50/50 border-amber-100">
            <div className="flex items-start gap-2.5">
              <Clock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-medium">Awaiting the director&apos;s submission.</p>
                <p className="mt-0.5 text-amber-700">They complete and e-sign via their secure link, or you can record it in person. Submitted data auto-populates the governance registers and the director&apos;s profile.</p>
              </div>
            </div>
          </Card>
        )}

        {/* Submitted content */}
        {isSubmitted && def && (
          <>
            <DeclarationReadView def={def} formData={data.form_data || {}} />
            <Card variant="default" padding="lg" className="mt-6">
              <div className="flex items-start gap-2.5 mb-4">
                <ShieldCheck className="w-5 h-5 text-primary-600 shrink-0 mt-0.5" />
                <p className="text-sm text-neutral-600">{def.attestation}</p>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-neutral-400 mb-1">Signature</p>
                  {data.signature
                    ? <img src={data.signature} alt="Signature" className="h-20 max-w-[260px] object-contain border border-neutral-200 rounded-lg bg-white" />
                    : <span className="text-neutral-400 text-sm">—</span>}
                </div>
                <div className="text-sm text-right">
                  <p className="font-semibold text-text-primary">{data.signed_name || data.director?.full_name}</p>
                  <p className="text-neutral-500 inline-flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-500" /> Signed {fmtDate(data.signed_at)}</p>
                </div>
              </div>
              {data.applied_to_profile && (
                <p className="mt-4 pt-4 border-t border-border text-xs text-emerald-700 inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" /> Director profile updated from this submission.
                </p>
              )}
            </Card>
          </>
        )}
      </div>

      {def && canManage && (
        <CompleteDeclarationModal
          isOpen={completeOpen}
          onClose={() => setCompleteOpen(false)}
          declarationId={String(id)}
          def={def}
          director={{ full_name: data.director?.full_name || 'Director' }}
          initialData={data.form_data || {}}
          onCompleted={load}
        />
      )}

      <ConfirmDialog
        isOpen={confirmCancel}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={doCancel}
        title="Cancel this declaration?"
        message="The director's secure link will stop working. You can issue a new one later."
        confirmLabel="Cancel declaration"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={doDelete}
        title="Delete this record?"
        message="This permanently removes the cancelled declaration record."
        confirmLabel="Delete"
        variant="danger"
      />
    </AppLayout>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-neutral-400">{label}</p>
      <p className="text-neutral-800 mt-0.5">{value}</p>
    </div>
  );
}

/** Read-only render of submitted declaration data, following the schema. */
function DeclarationReadView({ def, formData }: { def: DeclarationDef; formData: Record<string, any> }) {
  return (
    <div className="space-y-4">
      {def.sections.map((section, si) => (
        <Card key={si} variant="default" padding="lg">
          {section.title && <h3 className="text-sm font-semibold text-neutral-900 mb-3">{section.title}</h3>}
          {section.fields && (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {section.fields.map((f) => <ReadField key={f.key} f={f} value={formData[f.key]} />)}
            </dl>
          )}
          {section.repeatable && (() => {
            const r = section.repeatable!;
            const rows: any[] = Array.isArray(formData[r.key]) ? formData[r.key] : [];
            const nil = !!formData[`${r.key}_nil`];
            if (nil || rows.length === 0) {
              return <p className="text-sm text-neutral-500 italic">{nil ? `${r.nilLabel}.` : `No ${r.itemNoun}s declared.`}</p>;
            }
            return (
              <div className="space-y-3">
                {rows.map((row, i) => (
                  <div key={i} className="rounded-xl border border-neutral-200 p-3.5">
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                      {r.columns.map((c) => <ReadField key={c.key} f={c} value={row[c.key]} />)}
                    </dl>
                  </div>
                ))}
              </div>
            );
          })()}
        </Card>
      ))}
    </div>
  );
}

function ReadField({ f, value }: { f: FieldDef; value: any }) {
  let display: React.ReactNode;
  if (f.type === 'boolean') display = value === true ? 'Yes' : value === false ? 'No' : '—';
  else if (f.type === 'rating') display = value ? `${value} / 5` : '—';
  else if (value === undefined || value === null || String(value).trim() === '') display = <span className="text-neutral-300">—</span>;
  else if (f.type === 'date') display = fmtDate(value);
  else display = String(value);
  const span = f.colSpan === 2 || f.type === 'textarea' ? 'sm:col-span-2' : '';
  return (
    <div className={span}>
      <dt className="text-[11px] uppercase tracking-wider text-neutral-400">{f.label}</dt>
      <dd className="text-sm text-neutral-800 mt-0.5 whitespace-pre-wrap">{display}</dd>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
