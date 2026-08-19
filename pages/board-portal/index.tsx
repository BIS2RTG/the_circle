import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import SignatureCanvas from 'react-signature-canvas';
import PortalShell from '../../components/portal/PortalShell';
import { Modal, Button } from '../../components/ui';
import { useToast } from '../../components/ui/ToastProvider';
import { getDirectorSessionSSR } from '@/lib/directorSession';
import { declarationLabel, DECLARATION_STATUS_LABELS, DECLARATION_STATUS_STYLES, DeclarationStatus } from '@/lib/bgmDeclarations';
import {
  CalendarDays, MapPin, Video, CheckCircle2, Clock, FileSignature, PenLine,
  Crown, User, Eraser, ChevronRight,
} from 'lucide-react';

function fmtDT(iso?: string | null, tz?: string) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date(iso)); }
  catch { return new Date(iso).toLocaleString(); }
}
function fmtDate(iso?: string | null) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso)); } catch { return ''; }
}

export default function PortalDashboard({ directorName }: { directorName: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [signMeeting, setSignMeeting] = useState<any>(null);
  const [editProfile, setEditProfile] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch('/api/portal/me');
    if (r.ok) setData(await r.json());
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const outstanding = (data?.declarations || []).filter((d: any) => d.status === 'issued');
  const doneDeclarations = (data?.declarations || []).filter((d: any) => d.status !== 'issued' && d.status !== 'cancelled');
  const toConfirm = (data?.upcoming || []).filter((m: any) => !m.confirmed);

  return (
    <PortalShell title="Dashboard" directorName={directorName}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900">Welcome, {data?.director?.salutation ? `${data.director.salutation} ${data.director.full_name}` : directorName}</h1>
        <p className="text-sm text-neutral-500 mt-1">Your board schedule, attendance and governance declarations.</p>
      </div>

      {loading ? (
        <div className="py-16 text-center text-neutral-400">Loading…</div>
      ) : (
        <div className="space-y-6">
          {/* Action needed */}
          {(outstanding.length > 0 || toConfirm.length > 0) && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
              <h2 className="text-sm font-semibold text-amber-800 flex items-center gap-1.5"><Clock className="w-4 h-4" /> Action needed</h2>
              <div className="mt-3 space-y-2">
                {outstanding.map((d: any) => (
                  <Link key={d.id} href={`/board-portal/declarations/${d.id}`}
                    className="flex items-center gap-3 rounded-xl bg-white border border-amber-100 px-3.5 py-3 hover:border-amber-300 transition-colors">
                    <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0"><FileSignature className="w-4 h-4" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-neutral-900">{declarationLabel(d.declaration_type)}</p>
                      <p className="text-xs text-neutral-500">{d.period_year ? `${d.period_year} · ` : ''}{d.due_date ? `Due ${fmtDate(d.due_date)}` : 'Please complete & sign'}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-neutral-300 shrink-0" />
                  </Link>
                ))}
                {toConfirm.map((m: any) => (
                  <button key={m.id} onClick={() => setSignMeeting(m)}
                    className="w-full text-left flex items-center gap-3 rounded-xl bg-white border border-amber-100 px-3.5 py-3 hover:border-amber-300 transition-colors">
                    <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0"><PenLine className="w-4 h-4" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-neutral-900">Confirm attendance · {m.title}</p>
                      <p className="text-xs text-neutral-500">{fmtDT(m.scheduled_start, m.time_zone)}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-neutral-300 shrink-0" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Upcoming meetings */}
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-3 flex items-center gap-2"><CalendarDays className="w-5 h-5 text-primary-500" /> Upcoming meetings</h2>
            {(data?.upcoming || []).length === 0 ? (
              <EmptyCard label="No upcoming meetings scheduled." />
            ) : (
              <div className="space-y-2.5">
                {data.upcoming.map((m: any) => (
                  <div key={m.id} className="rounded-2xl border border-neutral-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-neutral-900">{m.title}</p>
                        <p className="text-sm text-neutral-500 mt-0.5 flex items-center gap-1.5"><CalendarDays className="w-4 h-4" /> {fmtDT(m.scheduled_start, m.time_zone)}</p>
                        <p className="text-sm text-neutral-500 mt-0.5 flex items-center gap-1.5">
                          {m.is_virtual ? <><Video className="w-4 h-4" /> {m.virtual_link ? <a href={m.virtual_link} target="_blank" rel="noreferrer" className="text-primary-600 hover:underline">Join link</a> : 'Virtual / hybrid'}</> : <><MapPin className="w-4 h-4" /> {m.location || 'In person'}</>}
                        </p>
                      </div>
                      {m.confirmed ? (
                        <span className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Attendance confirmed</span>
                      ) : (
                        <Button variant="primary" size="sm" onClick={() => setSignMeeting(m)}><PenLine className="w-4 h-4 mr-1.5" /> Confirm</Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Declarations history */}
          {doneDeclarations.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-neutral-900 mb-3 flex items-center gap-2"><FileSignature className="w-5 h-5 text-primary-500" /> My declarations</h2>
              <div className="rounded-2xl border border-neutral-200 bg-white divide-y divide-neutral-100 overflow-hidden">
                {doneDeclarations.map((d: any) => {
                  const st = (DECLARATION_STATUS_STYLES as any)[d.status] || DECLARATION_STATUS_STYLES.submitted;
                  return (
                    <div key={d.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-neutral-900">{declarationLabel(d.declaration_type)}</p>
                        <p className="text-xs text-neutral-500">{d.period_year ? `${d.period_year} · ` : ''}{d.submitted_at ? `Signed ${fmtDate(d.submitted_at)}` : ''}</p>
                      </div>
                      <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${st.bg} ${st.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{(DECLARATION_STATUS_LABELS as any)[d.status as DeclarationStatus] || d.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Past meetings */}
          {(data?.past || []).length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-neutral-900 mb-3">Recent meetings</h2>
              <div className="rounded-2xl border border-neutral-200 bg-white divide-y divide-neutral-100 overflow-hidden">
                {data.past.map((m: any) => (
                  <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-neutral-900">{m.title}</p>
                      <p className="text-xs text-neutral-500">{fmtDate(m.scheduled_start)}</p>
                    </div>
                    <AttendancePill status={m.my_status} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Profile */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2"><User className="w-5 h-5 text-primary-500" /> My profile</h2>
              <Button variant="outline" size="sm" onClick={() => setEditProfile(true)}>Edit</Button>
            </div>
            <div className="rounded-2xl border border-neutral-200 bg-white p-4">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-sm">
                <Info label="Name" value={data?.director?.salutation ? `${data.director.salutation} ${data.director.full_name}` : data?.director?.full_name} />
                <Info label="Email" value={data?.director?.email} />
                <Info label="Mobile" value={data?.director?.phone} />
              </dl>
              {(data?.committees || []).length > 0 && (
                <div className="mt-4 pt-4 border-t border-neutral-100">
                  <p className="text-[11px] uppercase tracking-wider text-neutral-400 mb-2">Committees</p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.committees.map((c: any) => (
                      <span key={c.id} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-neutral-100 text-neutral-700">
                        {c.is_chair && <Crown className="w-3 h-3 text-amber-500" />}{c.name}{c.is_chair && ' (Chair)'}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {signMeeting && (
        <ConfirmAttendanceModal meeting={signMeeting} onClose={() => setSignMeeting(null)}
          onDone={() => { setSignMeeting(null); addToast({ type: 'success', message: 'Attendance confirmed.' }); load(); }} />
      )}
      {editProfile && data && (
        <EditProfileModal profile={data.director} onClose={() => setEditProfile(false)}
          onDone={() => { setEditProfile(false); addToast({ type: 'success', message: 'Profile updated.' }); load(); }} />
      )}
    </PortalShell>
  );
}

function Info({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-neutral-400">{label}</dt>
      <dd className="text-neutral-800 mt-0.5">{value || <span className="text-neutral-300">—</span>}</dd>
    </div>
  );
}

function EmptyCard({ label }: { label: string }) {
  return <div className="rounded-2xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">{label}</div>;
}

function AttendancePill({ status }: { status: string | null }) {
  if (status === 'present' || status === 'virtual') return <span className="text-xs font-medium text-emerald-600 inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Attended</span>;
  if (status === 'apology' || status === 'absent') return <span className="text-xs font-medium text-neutral-400">Apology</span>;
  return <span className="text-xs text-neutral-300">—</span>;
}

function ConfirmAttendanceModal({ meeting, onClose, onDone }: { meeting: any; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sigRef = useRef<SignatureCanvas>(null);

  const submit = async () => {
    setError(null);
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign to confirm your attendance.'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/portal/attendance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meeting_id: meeting.id, signature: sigRef.current.getCanvas().toDataURL('image/png') }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not confirm attendance.');
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title="Confirm attendance" size="md">
      <div>
        <p className="text-sm text-neutral-500">Meeting</p>
        <p className="font-semibold text-neutral-900">{meeting.title}</p>
        <p className="text-sm text-neutral-500 mt-0.5 mb-4">{fmtDT(meeting.scheduled_start, meeting.time_zone)}</p>
        {error && <div className="mb-3 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}
        <label className="block text-sm font-medium text-neutral-700 mb-1">Sign below to confirm</label>
        <div className="border border-neutral-300 rounded-xl bg-white relative">
          <SignatureCanvas ref={sigRef} canvasProps={{ className: 'w-full h-44 rounded-xl', style: { touchAction: 'none' } }} backgroundColor="rgba(255,255,255,0)" />
          <button onClick={() => sigRef.current?.clear()} title="Clear" className="absolute top-2 right-2 p-1.5 rounded-lg bg-white border border-neutral-200 text-neutral-400 hover:text-neutral-700"><Eraser className="w-4 h-4" /></button>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={busy}>Confirm attendance</Button>
        </div>
      </div>
    </Modal>
  );
}

function EditProfileModal({ profile, onClose, onDone }: { profile: any; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ salutation: profile.salutation || '', email: profile.email || '', phone: profile.phone || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!form.email.trim()) { setError('An email address is required.'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/portal/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not update profile.');
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';
  return (
    <Modal isOpen onClose={onClose} title="Edit profile" size="md">
      <div className="space-y-3">
        {error && <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5 text-sm text-rose-700">{error}</div>}
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-1">Salutation</label>
          <select value={form.salutation} onChange={(e) => setForm({ ...form, salutation: e.target.value })} className={inputCls}>
            <option value="">—</option>
            {['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Adv', 'Eng', 'Hon'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-1">Email</label>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-1">Mobile number</label>
          <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} isLoading={busy}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getDirectorSessionSSR(ctx);
  if (!session) return { redirect: { destination: '/board-portal/login', permanent: false } };
  return { props: { directorName: session.director.full_name } };
};
