import { useRef, useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import SignatureCanvas from 'react-signature-canvas';
import { CheckCircle2, Eraser, ShieldCheck, MapPin, Video, CalendarClock, Loader2, AlertTriangle } from 'lucide-react';
import PortalBrand from '../../../components/portal/PortalBrand';
import DeclarationForm from '../../../components/legal/bgm/DeclarationForm';
import { getDeclarationDef } from '@/lib/bgmDeclarations';
import { DIRECTOR_ACTION_LABELS, DirectorAction } from '@/lib/directorPortal';

function fmtDT(iso?: string | null, tz?: string) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date(iso)); }
  catch { return new Date(iso).toLocaleString(); }
}

export default function SecureLinkPage() {
  const router = useRouter();
  const { token } = router.query;

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // action-specific state
  const [form, setForm] = useState<Record<string, any>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [signedName, setSignedName] = useState('');
  const [profile, setProfile] = useState<{ salutation: string; email: string; phone: string }>({ salutation: '', email: '', phone: '' });
  const sigRef = useRef<SignatureCanvas>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch(`/api/board/link/${token}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setLinkError(d.error || 'This link is not valid.'); setLoading(false); return; }
    setData(d);
    if (d.declaration) setForm(d.declaration.form_data || {});
    if (d.director) setSignedName(d.director.full_name || '');
    if (d.profile) setProfile({ salutation: d.profile.salutation || '', email: d.profile.email || '', phone: d.profile.phone || '' });
    setLoading(false);

    // Portal-login links establish a session immediately, then redirect.
    if (d.action === 'portal_login' && !d.already) {
      const pr = await fetch(`/api/board/link/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const pd = await pr.json().catch(() => ({}));
      if (pr.ok && pd.redirect) { router.replace(pd.redirect); return; }
      setLinkError(pd.error || 'This sign-in link could not be used. Please request a new one.');
    }
  }, [token, router]);

  useEffect(() => { if (token) load(); }, [token, load]);

  const post = async (payload: any) => {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/board/link/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Something went wrong.'); return false; }
      setDone(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    } catch { setError('Something went wrong. Please try again.'); return false; }
    finally { setBusy(false); }
  };

  const submitAttendance = async () => {
    setError(null);
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box to confirm your attendance.'); return; }
    await post({ signature: sigRef.current.getCanvas().toDataURL('image/png') });
  };

  const submitDeclaration = async () => {
    setError(null);
    if (!confirmed) { setError('Please tick the declaration to confirm.'); return; }
    if (!signedName.trim()) { setError('Please type your full name.'); return; }
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box below.'); return; }
    await post({ form_data: form, signature: sigRef.current.getCanvas().toDataURL('image/png'), signed_name: signedName.trim(), declaration_confirmed: true });
  };

  const submitProfile = async () => {
    setError(null);
    if (!profile.email.trim()) { setError('An email address is required.'); return; }
    await post({ salutation: profile.salutation, email: profile.email, phone: profile.phone });
  };

  const action: DirectorAction | undefined = data?.action;
  const def = data?.declaration ? getDeclarationDef(data.declaration.type) : null;
  const greet = data?.director ? (data.director.salutation ? `${data.director.salutation} ${data.director.full_name}` : data.director.full_name) : '';

  return (
    <>
      <Head><title>{action ? DIRECTOR_ACTION_LABELS[action] : 'Secure link'} · The Circle</title></Head>
      <div className="min-h-screen bg-neutral-50 flex flex-col items-center px-4 py-8">
        <div className="w-full max-w-2xl">
          <div className="mb-6"><PortalBrand /></div>

          {loading || (action === 'portal_login' && !linkError && !done) ? (
            <div className="bg-white rounded-2xl border border-neutral-200 p-10 text-center">
              <Loader2 className="w-8 h-8 text-primary-500 mx-auto mb-3 animate-spin" />
              <p className="text-sm text-neutral-500">{action === 'portal_login' ? 'Signing you in…' : 'Loading…'}</p>
            </div>
          ) : linkError ? (
            <div className="bg-white rounded-2xl border border-rose-100 p-8 text-center">
              <AlertTriangle className="w-12 h-12 text-rose-400 mx-auto mb-3" />
              <p className="text-rose-600 font-medium">{linkError}</p>
            </div>
          ) : done ? (
            <div className="bg-white rounded-2xl border border-emerald-100 p-8 text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
              <h1 className="text-lg font-bold text-neutral-900">All done</h1>
              <p className="text-sm text-neutral-500 mt-1">
                {action === 'confirm_attendance' && `Thank you, ${greet}. Your attendance has been recorded with your signature.`}
                {action === 'sign_declaration' && `Thank you, ${greet}. Your ${def?.shortLabel || 'declaration'} has been recorded with your signature.`}
                {action === 'update_profile' && `Thank you, ${greet}. Your profile has been updated.`}
              </p>
            </div>
          ) : data?.already ? (
            <div className="bg-white rounded-2xl border border-emerald-100 p-8 text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
              <h1 className="text-lg font-bold text-neutral-900">Already completed</h1>
              <p className="text-sm text-neutral-500 mt-1">{greet}, this has already been completed. Thank you.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-neutral-200 p-5 sm:p-7">
              {error && <div className="mb-4 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}

              {/* ---- Confirm attendance ---- */}
              {action === 'confirm_attendance' && (
                <>
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Rainbow Tourism Group · Board Governance</p>
                  <h1 className="mt-1 text-xl font-bold text-neutral-900">Confirm your attendance</h1>
                  <p className="text-sm text-neutral-500 mt-1">Good day, {greet}</p>
                  {data.meeting && (
                    <div className="mt-4 rounded-xl bg-neutral-50 border border-neutral-200 p-4">
                      <p className="font-semibold text-neutral-900">{data.meeting.title}</p>
                      <p className="text-sm text-neutral-500 mt-1 flex items-center gap-1.5"><CalendarClock className="w-4 h-4" /> {fmtDT(data.meeting.scheduled_start, data.meeting.time_zone)}</p>
                      <p className="text-sm text-neutral-500 mt-0.5 flex items-center gap-1.5">
                        {data.meeting.is_virtual ? <><Video className="w-4 h-4" /> Virtual / hybrid</> : <><MapPin className="w-4 h-4" /> {data.meeting.location || 'In person'}</>}
                      </p>
                    </div>
                  )}
                  <p className="text-sm text-neutral-600 mt-4 mb-1">Please sign below to confirm your attendance.</p>
                  <SignPad sigRef={sigRef} />
                  <SubmitButton onClick={submitAttendance} busy={busy} label="Confirm my attendance" />
                </>
              )}

              {/* ---- Sign declaration ---- */}
              {action === 'sign_declaration' && def && (
                <>
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Rainbow Tourism Group · Board Governance</p>
                  <h1 className="mt-1 text-2xl font-bold text-neutral-900">{def.title}</h1>
                  <p className="text-sm text-neutral-500 mt-0.5">For {greet}{data.declaration?.period_year ? ` · ${data.declaration.period_year}` : ''}</p>
                  <p className="mt-4 text-sm text-neutral-600 leading-relaxed">{def.instructions}</p>
                  <div className="mt-6"><DeclarationForm def={def} value={form} onChange={setForm} /></div>
                  <div className="mt-8 pt-6 border-t border-neutral-100">
                    <Attestation text={def.attestation} confirmed={confirmed} onChange={setConfirmed} />
                    <label className="block text-sm font-medium text-neutral-700 mt-4 mb-1">Full name</label>
                    <input value={signedName} onChange={(e) => setSignedName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                    <label className="block text-sm font-medium text-neutral-700 mt-4 mb-1">Signature</label>
                    <SignPad sigRef={sigRef} />
                    <SubmitButton onClick={submitDeclaration} busy={busy} label="Submit & sign declaration" />
                  </div>
                </>
              )}

              {/* ---- Update profile ---- */}
              {action === 'update_profile' && (
                <>
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Rainbow Tourism Group · Board Governance</p>
                  <h1 className="mt-1 text-xl font-bold text-neutral-900">Update your profile</h1>
                  <p className="text-sm text-neutral-500 mt-1 mb-5">Good day, {greet}. Please review and update your contact details.</p>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 mb-1">Salutation</label>
                      <select value={profile.salutation} onChange={(e) => setProfile({ ...profile, salutation: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                        <option value="">—</option>
                        {['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Adv', 'Eng', 'Hon'].map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 mb-1">Email</label>
                      <input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 mb-1">Mobile number</label>
                      <input type="tel" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                    </div>
                  </div>
                  <SubmitButton onClick={submitProfile} busy={busy} label="Save my details" />
                </>
              )}

              <p className="mt-4 text-center text-xs text-neutral-400">This is a secure, single-use personal link. Please do not forward it.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function SignPad({ sigRef }: { sigRef: React.RefObject<SignatureCanvas> }) {
  return (
    <div className="border border-neutral-300 rounded-xl bg-white relative">
      <SignatureCanvas ref={sigRef} canvasProps={{ className: 'w-full h-44 rounded-xl', style: { touchAction: 'none' } }} backgroundColor="rgba(255,255,255,0)" />
      <button onClick={() => sigRef.current?.clear()} title="Clear"
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700">
        <Eraser className="w-4 h-4" />
      </button>
      <span className="absolute bottom-2 left-3 text-xs text-neutral-300 pointer-events-none">Sign here</span>
    </div>
  );
}

function Attestation({ text, confirmed, onChange }: { text: string; confirmed: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-primary-50/60 border border-primary-100 p-3.5">
      <ShieldCheck className="w-5 h-5 text-primary-600 shrink-0 mt-0.5" />
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={confirmed} onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
        <span className="text-sm text-neutral-700">{text}</span>
      </label>
    </div>
  );
}

function SubmitButton({ onClick, busy, label }: { onClick: () => void; busy: boolean; label: string }) {
  return (
    <button disabled={busy} onClick={onClick}
      className="w-full mt-5 py-3 rounded-xl bg-primary-600 text-white font-semibold disabled:opacity-50 hover:bg-primary-700 transition-colors">
      {busy ? 'Submitting…' : label}
    </button>
  );
}
