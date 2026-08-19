import { useRef, useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import SignatureCanvas from 'react-signature-canvas';
import { CheckCircle2, Eraser, ShieldCheck, CalendarClock } from 'lucide-react';
import DeclarationForm from '../../../components/legal/bgm/DeclarationForm';
import { getDeclarationDef, DeclarationDef } from '@/lib/bgmDeclarations';

/**
 * PUBLIC (token-gated, no login) governance declaration — a director opens their
 * personal link, completes the digital form and e-signs. Mirrors the board
 * attendance signing page's chrome.
 */
export default function BoardDeclaration() {
  const router = useRouter();
  const { token } = router.query;

  const [loading, setLoading] = useState(true);
  const [def, setDef] = useState<DeclarationDef | null>(null);
  const [director, setDirector] = useState<{ full_name: string; salutation: string | null } | null>(null);
  const [meta, setMeta] = useState<{ period_year: number | null; due_date: string | null }>({ period_year: null, due_date: null });
  const [form, setForm] = useState<Record<string, any>>({});
  const [signedName, setSignedName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [already, setAlready] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const sigRef = useRef<SignatureCanvas>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      setLoading(true);
      const r = await fetch(`/api/legal/bgm/declaration/${token}`);
      if (r.ok) {
        const d = await r.json();
        setDef(getDeclarationDef(d.type));
        setDirector(d.director);
        setMeta({ period_year: d.declaration?.period_year ?? null, due_date: d.declaration?.due_date ?? null });
        setForm(d.declaration?.form_data || {});
        setSignedName(d.director?.full_name || '');
        setAlready(!!d.already);
      } else {
        setLinkError((await r.json().catch(() => ({}))).error || 'This declaration link is not valid.');
      }
      setLoading(false);
    })();
  }, [token]);

  const submit = async () => {
    setError(null);
    // Required-field validation from the schema.
    const missing = validateRequired(def, form);
    if (missing) { setError(missing); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (!confirmed) { setError('Please tick the declaration box to confirm.'); return; }
    if (!signedName.trim()) { setError('Please type your full name.'); return; }
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box below.'); return; }

    const signature = sigRef.current.getCanvas().toDataURL('image/png');
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/declaration/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form_data: form, signature, signed_name: signedName.trim(), declaration_confirmed: true }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not submit your declaration.'); return; }
      setDone(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch { setError('Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };

  const greet = director ? (director.salutation ? `${director.salutation} ${director.full_name}` : director.full_name) : '';

  return (
    <>
      <Head><title>{def ? `${def.title} · The Circle` : 'Governance Declaration · The Circle'}</title></Head>
      <div className="min-h-screen bg-neutral-50 flex flex-col items-center px-4 py-8">
        <div className="w-full max-w-2xl">
          <div className="flex items-center gap-2 mb-6">
            <svg className="w-8 h-8" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs><linearGradient id="dg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#9A7545" /><stop offset="100%" stopColor="#C9A574" /></linearGradient></defs>
              <path d="M 100 25 C 145 25, 180 60, 180 100 C 180 145, 145 180, 100 180 C 55 180, 20 145, 20 100 C 20 60, 52 28, 95 25 L 100 25 L 98 40 C 60 42, 35 65, 35 100 C 35 138, 65 167, 100 167 C 138 167, 167 138, 167 100 C 167 65, 140 38, 100 38 Z" fill="url(#dg)" />
            </svg>
            <span className="font-bold text-lg tracking-tight">The Circle</span>
          </div>

          {loading ? (
            <p className="text-center text-neutral-400 py-16">Loading…</p>
          ) : linkError ? (
            <div className="bg-white rounded-2xl border border-rose-100 p-6 text-center"><p className="text-rose-600 font-medium">{linkError}</p></div>
          ) : done || already ? (
            <div className="bg-white rounded-2xl border border-emerald-100 p-8 text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
              <h1 className="text-lg font-bold text-neutral-900">{already && !done ? 'Already submitted' : 'Declaration submitted'}</h1>
              <p className="text-sm text-neutral-500 mt-1">
                {already && !done
                  ? `${greet}, this declaration has already been completed. Thank you.`
                  : `Thank you, ${greet}. Your ${def?.shortLabel || 'declaration'} has been recorded with your signature.`}
              </p>
            </div>
          ) : def ? (
            <div className="bg-white rounded-2xl border border-neutral-200 p-5 sm:p-7">
              {/* Header */}
              <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Rainbow Tourism Group · Board Governance</p>
              <h1 className="mt-1 text-2xl font-bold text-neutral-900">{def.title}</h1>
              <p className="text-sm text-neutral-500 mt-0.5">
                For {greet}{meta.period_year ? ` · ${meta.period_year} governance year` : ''}
              </p>
              {meta.due_date && (
                <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 rounded-full px-2.5 py-1">
                  <CalendarClock className="w-3.5 h-3.5" /> Please complete by {new Date(meta.due_date).toLocaleDateString('en-GB', { dateStyle: 'long' } as any)}
                </p>
              )}
              <p className="mt-4 text-sm text-neutral-600 leading-relaxed">{def.instructions}</p>

              {error && <div className="mt-4 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

              {/* Form */}
              <div className="mt-6">
                <DeclarationForm def={def} value={form} onChange={setForm} />
              </div>

              {/* Attestation + signature */}
              <div className="mt-8 pt-6 border-t border-neutral-100">
                <div className="flex items-start gap-2.5 rounded-xl bg-primary-50/60 border border-primary-100 p-3.5">
                  <ShieldCheck className="w-5 h-5 text-primary-600 shrink-0 mt-0.5" />
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                    <span className="text-sm text-neutral-700">{def.attestation}</span>
                  </label>
                </div>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Full name</label>
                    <input value={signedName} onChange={(e) => setSignedName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <div className="text-xs text-neutral-400 sm:text-right">Signed {new Date().toLocaleDateString('en-GB', { dateStyle: 'long' } as any)}</div>
                </div>

                <label className="block text-sm font-medium text-neutral-700 mt-4 mb-1">Signature</label>
                <div className="border border-neutral-300 rounded-xl bg-white relative">
                  <SignatureCanvas ref={sigRef}
                    canvasProps={{ className: 'w-full h-44 rounded-xl', style: { touchAction: 'none' } }}
                    backgroundColor="rgba(255,255,255,0)" />
                  <button onClick={() => sigRef.current?.clear()} title="Clear"
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700">
                    <Eraser className="w-4 h-4" />
                  </button>
                  <span className="absolute bottom-2 left-3 text-xs text-neutral-300 pointer-events-none">Sign here</span>
                </div>

                <button disabled={busy} onClick={submit}
                  className="w-full mt-5 py-3 rounded-xl bg-primary-600 text-white font-semibold disabled:opacity-50 hover:bg-primary-700 transition-colors">
                  {busy ? 'Submitting…' : 'Submit & sign declaration'}
                </button>
                <p className="mt-3 text-center text-xs text-neutral-400">
                  By submitting you are applying your electronic signature. This declaration forms part of RTG&apos;s statutory governance records.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** Validate required schema fields; returns an error message or null. */
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
    // Repeatables: require at least one row unless the nil box is ticked.
    const r = section.repeatable;
    if (r) {
      const rows = Array.isArray(form[r.key]) ? form[r.key] : [];
      const nil = !!form[`${r.key}_nil`];
      if (!nil && rows.length === 0) return `Please add at least one ${r.itemNoun}, or tick "${r.nilLabel}".`;
      // required columns within each row
      for (const row of rows) {
        for (const c of r.columns) {
          if (c.required && (row[c.key] === undefined || String(row[c.key] ?? '').trim() === '')) {
            return `Please complete "${c.label}" for each ${r.itemNoun}.`;
          }
        }
      }
    }
  }
  return null;
}
