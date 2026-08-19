import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import SignatureCanvas from 'react-signature-canvas';
import PortalShell from '../../../components/portal/PortalShell';
import DeclarationForm from '../../../components/legal/bgm/DeclarationForm';
import { getDirectorSessionSSR } from '@/lib/directorSession';
import { getDeclarationDef, DeclarationDef } from '@/lib/bgmDeclarations';
import { ArrowLeft, Eraser, ShieldCheck, CheckCircle2, CalendarClock } from 'lucide-react';

export default function PortalDeclaration({ directorName }: { directorName: string }) {
  const router = useRouter();
  const { id } = router.query;

  const [loading, setLoading] = useState(true);
  const [def, setDef] = useState<DeclarationDef | null>(null);
  const [meta, setMeta] = useState<{ period_year: number | null; due_date: string | null }>({ period_year: null, due_date: null });
  const [form, setForm] = useState<Record<string, any>>({});
  const [signedName, setSignedName] = useState(directorName || '');
  const [confirmed, setConfirmed] = useState(false);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const sigRef = useRef<SignatureCanvas>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const r = await fetch(`/api/portal/declaration?id=${id}`);
    if (!r.ok) { setNotFound(true); setLoading(false); return; }
    const d = await r.json();
    setDef(getDeclarationDef(d.type));
    setMeta({ period_year: d.declaration?.period_year ?? null, due_date: d.declaration?.due_date ?? null });
    setForm(d.declaration?.form_data || {});
    if (d.status === 'submitted') setAlreadyDone(true);
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setError(null);
    const missing = validateRequired(def, form);
    if (missing) { setError(missing); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (!confirmed) { setError('Please tick the declaration box to confirm.'); return; }
    if (!signedName.trim()) { setError('Please type your full name.'); return; }
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box below.'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/portal/declaration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, form_data: form, signature: sigRef.current.getCanvas().toDataURL('image/png'), signed_name: signedName.trim(), declaration_confirmed: true }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not submit your declaration.'); return; }
      setDone(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch { setError('Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };

  return (
    <PortalShell title={def?.shortLabel || 'Declaration'} directorName={directorName}>
      <Link href="/board-portal" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      {loading ? (
        <div className="py-16 text-center text-neutral-400">Loading…</div>
      ) : notFound ? (
        <div className="rounded-2xl border border-rose-100 bg-white p-8 text-center text-rose-600">This declaration could not be found.</div>
      ) : done || alreadyDone ? (
        <div className="rounded-2xl border border-emerald-100 bg-white p-8 text-center">
          <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
          <h1 className="text-lg font-bold text-neutral-900">{alreadyDone && !done ? 'Already submitted' : 'Declaration submitted'}</h1>
          <p className="text-sm text-neutral-500 mt-1">Thank you. Your {def?.shortLabel || 'declaration'} is recorded.</p>
          <Link href="/board-portal" className="inline-block mt-4 text-sm font-medium text-primary-600 hover:underline">Return to dashboard</Link>
        </div>
      ) : def ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Rainbow Tourism Group · Board Governance</p>
          <h1 className="mt-1 text-2xl font-bold text-neutral-900">{def.title}</h1>
          {meta.period_year && <p className="text-sm text-neutral-500 mt-0.5">{meta.period_year} governance year</p>}
          {meta.due_date && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 rounded-full px-2.5 py-1">
              <CalendarClock className="w-3.5 h-3.5" /> Please complete by {new Date(meta.due_date).toLocaleDateString('en-GB', { dateStyle: 'long' } as any)}
            </p>
          )}
          <p className="mt-4 text-sm text-neutral-600 leading-relaxed">{def.instructions}</p>

          {error && <div className="mt-4 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

          <div className="mt-6"><DeclarationForm def={def} value={form} onChange={setForm} /></div>

          <div className="mt-8 pt-6 border-t border-neutral-100">
            <div className="flex items-start gap-2.5 rounded-xl bg-primary-50/60 border border-primary-100 p-3.5">
              <ShieldCheck className="w-5 h-5 text-primary-600 shrink-0 mt-0.5" />
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                <span className="text-sm text-neutral-700">{def.attestation}</span>
              </label>
            </div>
            <label className="block text-sm font-medium text-neutral-700 mt-4 mb-1">Full name</label>
            <input value={signedName} onChange={(e) => setSignedName(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <label className="block text-sm font-medium text-neutral-700 mt-4 mb-1">Signature</label>
            <div className="border border-neutral-300 rounded-xl bg-white relative">
              <SignatureCanvas ref={sigRef} canvasProps={{ className: 'w-full h-44 rounded-xl', style: { touchAction: 'none' } }} backgroundColor="rgba(255,255,255,0)" />
              <button onClick={() => sigRef.current?.clear()} title="Clear" className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700"><Eraser className="w-4 h-4" /></button>
              <span className="absolute bottom-2 left-3 text-xs text-neutral-300 pointer-events-none">Sign here</span>
            </div>
            <button disabled={busy} onClick={submit} className="w-full mt-5 py-3 rounded-xl bg-primary-600 text-white font-semibold disabled:opacity-50 hover:bg-primary-700 transition-colors">
              {busy ? 'Submitting…' : 'Submit & sign declaration'}
            </button>
          </div>
        </div>
      ) : null}
    </PortalShell>
  );
}

function validateRequired(def: DeclarationDef | null, form: Record<string, any>): string | null {
  if (!def) return null;
  for (const section of def.sections) {
    for (const f of section.fields || []) {
      if (!f.required) continue;
      const v = form[f.key];
      if (f.type === 'boolean') { if (typeof v !== 'boolean') return `Please answer: "${f.label}"`; }
      else if (f.type === 'rating') { if (!v) return `Please rate: "${f.label}"`; }
      else if (v === undefined || v === null || String(v).trim() === '') return `Please complete: "${f.label}"`;
    }
    const r = section.repeatable;
    if (r) {
      const rows = Array.isArray(form[r.key]) ? form[r.key] : [];
      const nil = !!form[`${r.key}_nil`];
      if (!nil && rows.length === 0) return `Please add at least one ${r.itemNoun}, or tick "${r.nilLabel}".`;
      for (const row of rows) {
        for (const c of r.columns) {
          if (c.required && (row[c.key] === undefined || String(row[c.key] ?? '').trim() === '')) return `Please complete "${c.label}" for each ${r.itemNoun}.`;
        }
      }
    }
  }
  return null;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getDirectorSessionSSR(ctx);
  if (!session) return { redirect: { destination: '/board-portal/login', permanent: false } };
  return { props: { directorName: session.director.full_name } };
};
