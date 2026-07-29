import { useRef, useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import SignatureCanvas from 'react-signature-canvas';
import { CheckCircle2, MapPin, Video, Eraser } from 'lucide-react';

/**
 * PUBLIC personalised self check-in reached from a per-attendee email link.
 * The token identifies the person, so we greet them by name and they just sign.
 */
export default function BoardAttend() {
  const router = useRouter();
  const { token } = router.query;

  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [meeting, setMeeting] = useState<any>(null);
  const [open, setOpen] = useState(false);
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
      const r = await fetch(`/api/legal/bgm/attend/${token}`);
      if (r.ok) { const d = await r.json(); setName(d.name); setMeeting(d.meeting); setOpen(d.open); setAlready(d.already); }
      else setLinkError((await r.json().catch(() => ({}))).error || 'This attendance link is not valid.');
      setLoading(false);
    })();
  }, [token]);

  const submit = async () => {
    setError(null);
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box to confirm your attendance.'); return; }
    const signature = sigRef.current.getCanvas().toDataURL('image/png');
    setBusy(true);
    try {
      const r = await fetch(`/api/legal/bgm/attend/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not record your check-in.'); return; }
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

          {loading ? (
            <p className="text-center text-neutral-400 py-16">Loading…</p>
          ) : linkError ? (
            <div className="bg-white rounded-2xl border border-rose-100 p-6 text-center"><p className="text-rose-600 font-medium">{linkError}</p></div>
          ) : done || already ? (
            <div className="bg-white rounded-2xl border border-emerald-100 p-8 text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
              <h1 className="text-lg font-bold text-neutral-900">{already && !done ? 'Already registered' : "You're checked in"}</h1>
              <p className="text-sm text-neutral-500 mt-1">
                {already && !done ? `${name}, your attendance for this meeting is already recorded.` : `Thank you, ${name}. Your attendance has been recorded with your signature.`}
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-neutral-200 p-5">
              <p className="text-sm text-neutral-500">Good day,</p>
              <h1 className="text-xl font-bold text-neutral-900">{name}</h1>
              <p className="text-sm text-neutral-600 mt-1 mb-1">Please sign below to confirm your attendance at</p>
              <p className="font-semibold text-neutral-900">{meeting?.title}</p>
              <p className="text-sm text-neutral-500 mt-0.5 mb-4 flex items-center gap-1.5">
                {meeting?.is_virtual ? <><Video className="w-4 h-4" /> Virtual / hybrid</> : <><MapPin className="w-4 h-4" /> In person</>}
              </p>

              {!open && (
                <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800">
                  Check-in isn&apos;t open right now. It opens shortly before the meeting starts.
                </div>
              )}
              {error && <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 mb-4 text-sm text-rose-700">{error}</div>}

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

              <button disabled={!open || busy} onClick={submit}
                className="w-full mt-4 py-2.5 rounded-xl bg-primary-600 text-white font-medium disabled:opacity-50">
                {busy ? 'Recording…' : 'Confirm my attendance'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
