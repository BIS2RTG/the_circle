import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { buildAttendView } from '@/lib/bgmSSR';
import SignatureSelector, { SignatureSelection } from '@/components/approvals/SignatureSelector';
import { CheckCircle2, MapPin, Video, FileSignature } from 'lucide-react';

/**
 * PUBLIC personalised sign page reached from a per-attendee email link. SSR so it
 * loads instantly (board members disliked the client-fetch spinner). The token
 * identifies the person; they see what they are acknowledging, then sign — using
 * the same signing pad as the rest of the app (iPad-safe, saved-or-draw).
 */
export default function BoardAttend({ initial }: { initial: any }) {
  const router = useRouter();
  const { token } = router.query;

  const linkError = initial?.valid === false ? (initial.error || 'This attendance link is not valid.') : null;
  const name: string = initial?.name || '';
  const meeting = initial?.meeting || null;
  const open: boolean = !!initial?.open;
  const termsRequired: boolean = !!initial?.terms_required;
  const savedSignature: string | null = initial?.saved_signature || null;
  const acknowledgment: string = initial?.acknowledgment || `your attendance at “${meeting?.title || ''}”`;

  const [already, setAlready] = useState<boolean>(!!initial?.already);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [agree, setAgree] = useState(false);
  const [sel, setSel] = useState<SignatureSelection>({ type: savedSignature ? 'saved' : 'manual' });

  const submit = async () => {
    setError(null);
    if (termsRequired && !agree) { setError('Please accept the terms to confirm.'); return; }

    let signature: string | undefined;
    if (sel.type === 'saved' && savedSignature) signature = savedSignature;
    else if (sel.type === 'manual' && sel.data) signature = sel.data;
    if (!signature) { setError('Please sign in the box to confirm.'); return; }

    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/attend/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature, agree_terms: agree || !termsRequired }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not record your signature.'); if (r.status === 409) setAlready(true); return; }
      setDone(true);
    } catch { setError('Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Head><title>Sign for attendance · The Circle</title></Head>
      <div className="min-h-screen bg-neutral-50 flex flex-col items-center px-4 py-8">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-2 mb-6">
            <svg className="w-8 h-8" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs><linearGradient id="at" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#9A7545" /><stop offset="100%" stopColor="#C9A574" /></linearGradient></defs>
              <path d="M 100 25 C 145 25, 180 60, 180 100 C 180 145, 145 180, 100 180 C 55 180, 20 145, 20 100 C 20 60, 52 28, 95 25 L 100 25 L 98 40 C 60 42, 35 65, 35 100 C 35 138, 65 167, 100 167 C 138 167, 167 138, 167 100 C 167 65, 140 38, 100 38 Z" fill="url(#at)" />
            </svg>
            <span className="font-bold text-lg tracking-tight">The Circle</span>
          </div>

          {linkError ? (
            <div className="bg-white rounded-2xl border border-rose-100 p-6 text-center"><p className="text-rose-600 font-medium">{linkError}</p></div>
          ) : done || already ? (
            <div className="bg-white rounded-2xl border border-emerald-100 p-8 text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
              <h1 className="text-lg font-bold text-neutral-900">{already && !done ? 'Already signed' : 'Thank you'}</h1>
              <p className="text-sm text-neutral-500 mt-1">
                {already && !done ? `${name}, your signature for this meeting is already recorded.` : `Thank you, ${name}. Your signature has been recorded.`}
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-neutral-200 p-5">
              <p className="text-sm text-neutral-500">Good day,</p>
              <h1 className="text-xl font-bold text-neutral-900">{name}</h1>
              <p className="text-sm text-neutral-600 mt-1 mb-1">Please sign below for</p>
              <p className="font-semibold text-neutral-900">{meeting?.title}</p>
              <p className="text-sm text-neutral-500 mt-0.5 mb-3 flex items-center gap-1.5">
                {meeting?.is_virtual ? <><Video className="w-4 h-4" /> Virtual / hybrid</> : <><MapPin className="w-4 h-4" /> In person</>}
              </p>

              {/* What the member is acknowledging by signing. */}
              <div className="bg-primary-50/60 border border-primary-100 rounded-xl px-4 py-3 mb-4 text-sm text-neutral-700 flex gap-2">
                <FileSignature className="w-4 h-4 text-primary-600 shrink-0 mt-0.5" />
                <span>By signing, you confirm <strong>{acknowledgment}</strong>.</span>
              </div>

              {!open && (
                <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800">
                  Signing isn&apos;t open right now. It opens shortly before the meeting and stays open until the register is closed.
                </div>
              )}

              <SignatureSelector savedSignatureUrl={savedSignature} value={sel} onChange={(s) => { setSel(s); setError(null); }} />

              {/* Terms agreement (external / non-HRIMS members, first time) */}
              {termsRequired && (
                <label className="flex items-start gap-2.5 mt-3 cursor-pointer">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)}
                    className="w-4 h-4 mt-0.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500" />
                  <span className="text-sm text-neutral-600">
                    I agree to the{' '}
                    <a href="/board/terms" target="_blank" rel="noreferrer" className="text-primary-600 underline">Board e-Signature Terms</a>{' '}
                    covering the use and storage of my digital signature.
                  </span>
                </label>
              )}

              {error && <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 mt-3 text-sm text-rose-700">{error}</div>}

              <button disabled={!open || busy || (termsRequired && !agree)} onClick={submit}
                className="w-full mt-4 py-2.5 rounded-xl bg-primary-600 text-white font-medium disabled:opacity-50">
                {busy ? 'Recording…' : 'Sign & confirm'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const token = String(context.params?.token || '');
  const view = await buildAttendView(token);
  return { props: { initial: JSON.parse(JSON.stringify(view)) } };
};
