import { useRef, useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import SignatureCanvas from 'react-signature-canvas';
import { CheckCircle2, MapPin, Video, Eraser } from 'lucide-react';

/**
 * PUBLIC self check-in reached by scanning a meeting's QR code. No login and
 * NO attendee roster — you identify yourself with your invited email and
 * confirm with your own signature, so nobody can mark someone else present.
 */
export default function BoardCheckIn() {
  const router = useRouter();
  const { token } = router.query;

  const [loading, setLoading] = useState(true);
  const [meeting, setMeeting] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [step, setStep] = useState<'identify' | 'sign' | 'done'>('identify');
  const [email, setEmail] = useState('');
  const [attendee, setAttendee] = useState<{ id: string; kind: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sigRef = useRef<SignatureCanvas>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      setLoading(true);
      const r = await fetch(`/api/legal/bgm/checkin/${token}`);
      if (r.ok) { const d = await r.json(); setMeeting(d.meeting); setOpen(d.open); }
      else setLinkError((await r.json().catch(() => ({}))).error || 'This check-in link is not valid.');
      setLoading(false);
    })();
  }, [token]);

  const identify = async () => {
    setError(null);
    if (!email.trim()) { setError('Please enter your email.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/checkin/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'identify', email: email.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not find you on the invite list.'); return; }
      setAttendee({ id: d.attendee_id, kind: d.kind, name: d.name });
      setStep('sign');
    } catch { setError('Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setError(null);
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box to confirm your attendance.'); return; }
    const signature = sigRef.current.getCanvas().toDataURL('image/png');
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/checkin/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'checkin', attendee_id: attendee!.id, kind: attendee!.kind, mode: 'present', signature }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not record your check-in.'); return; }
      setStep('done');
    } catch { setError('Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Head><title>Meeting check-in · The Circle</title></Head>
      <div className="min-h-screen bg-neutral-50 flex flex-col items-center px-4 py-8">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-2 mb-6">
            <svg className="w-8 h-8" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs><linearGradient id="ci" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#9A7545" /><stop offset="100%" stopColor="#C9A574" /></linearGradient></defs>
              <path d="M 100 25 C 145 25, 180 60, 180 100 C 180 145, 145 180, 100 180 C 55 180, 20 145, 20 100 C 20 60, 52 28, 95 25 L 100 25 L 98 40 C 60 42, 35 65, 35 100 C 35 138, 65 167, 100 167 C 138 167, 167 138, 167 100 C 167 65, 140 38, 100 38 Z" fill="url(#ci)" />
            </svg>
            <span className="font-bold text-lg tracking-tight">The Circle</span>
          </div>

          {loading ? (
            <p className="text-center text-neutral-400 py-16">Loading…</p>
          ) : linkError ? (
            <div className="bg-white rounded-2xl border border-rose-100 p-6 text-center"><p className="text-rose-600 font-medium">{linkError}</p></div>
          ) : step === 'done' ? (
            <div className="bg-white rounded-2xl border border-emerald-100 p-8 text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
              <h1 className="text-lg font-bold text-neutral-900">You&apos;re checked in</h1>
              <p className="text-sm text-neutral-500 mt-1">Thank you, {attendee?.name}. Your attendance has been recorded with your signature.</p>
            </div>
          ) : (
            <>
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Meeting check-in</p>
                <h1 className="text-xl font-bold text-neutral-900">{meeting?.title}</h1>
                <p className="text-sm text-neutral-500 mt-0.5 flex items-center gap-1.5">
                  {meeting?.is_virtual ? <><Video className="w-4 h-4" /> Virtual / hybrid</> : <><MapPin className="w-4 h-4" /> In person</>}
                </p>
              </div>

              {!open && (
                <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800">
                  Check-in isn&apos;t open right now. It opens shortly before the meeting starts.
                </div>
              )}

              {error && <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 mb-4 text-sm text-rose-700">{error}</div>}

              {step === 'identify' && (
                <div className="bg-white rounded-2xl border border-neutral-200 p-5">
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Your email</label>
                  <p className="text-xs text-neutral-500 mb-3">Enter the email address you were invited with. We&apos;ll only show your own record.</p>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoCapitalize="none"
                    placeholder="you@example.com"
                    className="w-full px-4 py-2.5 rounded-xl border border-neutral-200 focus:outline-none focus:ring-2 focus:ring-primary-500 mb-3"
                    onKeyDown={(e) => { if (e.key === 'Enter') identify(); }} />
                  <button disabled={!open || busy} onClick={identify}
                    className="w-full py-2.5 rounded-xl bg-primary-600 text-white font-medium disabled:opacity-50">
                    {busy ? 'Checking…' : 'Continue'}
                  </button>
                </div>
              )}

              {step === 'sign' && attendee && (
                <div className="bg-white rounded-2xl border border-neutral-200 p-5">
                  <p className="text-sm text-neutral-500">Checking in as</p>
                  <p className="text-lg font-bold text-neutral-900 mb-4">{attendee.name}</p>

                  <label className="block text-sm font-medium text-neutral-700 mb-1">Sign to confirm your attendance</label>
                  <div className="border border-neutral-300 rounded-xl bg-white relative">
                    <SignatureCanvas ref={sigRef}
                      canvasProps={{ className: 'w-full h-40 rounded-xl', style: { touchAction: 'none' } }}
                      backgroundColor="rgba(255,255,255,0)" />
                    <button onClick={() => sigRef.current?.clear()} className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700" title="Clear">
                      <Eraser className="w-4 h-4" />
                    </button>
                  </div>

                  <button disabled={!open || busy} onClick={submit}
                    className="w-full mt-4 py-2.5 rounded-xl bg-primary-600 text-white font-medium disabled:opacity-50">
                    {busy ? 'Recording…' : 'Confirm my attendance'}
                  </button>
                  <button onClick={() => { setStep('identify'); setAttendee(null); setError(null); }} className="w-full mt-2 text-xs text-neutral-500">Not you? Go back</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
