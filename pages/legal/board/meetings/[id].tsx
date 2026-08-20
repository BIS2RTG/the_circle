import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]';
import { AppLayout } from '../../../../components/layout';
import { Card, Button, Modal } from '../../../../components/ui';
import ConfirmDialog from '../../../../components/ui/ConfirmDialog';
import Loader from '@/components/Loader';
import { useToast } from '../../../../components/ui/ToastProvider';
import { useRBAC, useRequirePermission } from '../../../../contexts/RBACContext';
import { AssociatesField, Associate } from '../../../../components/requests/AssociatesField';
import { AttendanceStatus, CHECK_IN_METHOD_LABELS, VIRTUAL_PLATFORM_LABELS } from '@/lib/bgm';
import QrCheckInModal from '../../../../components/legal/bgm/QrCheckInModal';
import SignatureCaptureModal from '../../../../components/legal/bgm/SignatureCaptureModal';
import SignPromptModal from '../../../../components/legal/bgm/SignPromptModal';
import AttendanceEmailModal from '../../../../components/legal/bgm/AttendanceEmailModal';
import { ArrowLeft, MapPin, Video, CalendarClock, Send, Ban, Save, Lock, LockOpen, UserPlus, X, ShieldCheck, QrCode, FileText, PenLine, Mail } from 'lucide-react';

function fmtRange(start: string, end: string | null, tz?: string) {
  try {
    const s = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date(start));
    if (!end) return s;
    const et = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: tz }).format(new Date(end));
    return `${s} – ${et}`;
  } catch { return new Date(start).toLocaleString(); }
}
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null);

export default function MeetingDetail() {
  const router = useRouter();
  const { id } = router.query;
  const { addToast } = useToast();
  const { hasPermission } = useRBAC();
  useRequirePermission(['bgm.meetings.view', 'bgm.attendance.view', 'legal.access']);
  const canManageMeeting = hasPermission('bgm.meetings.manage');
  const canManageAttendance = hasPermission('bgm.attendance.manage');

  const [meeting, setMeeting] = useState<any>(null);
  const [register, setRegister] = useState<any[]>([]);
  const [guests, setGuests] = useState<any[]>([]);
  const [quorum, setQuorum] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [signFor, setSignFor] = useState<{ id: string; kind: 'director' | 'guest'; name: string } | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const finalized = !!meeting?.finalized_at;
  const editable = canManageAttendance && !finalized && meeting?.status !== 'cancelled';
  const started = !!meeting && new Date(meeting.scheduled_start).getTime() <= Date.now();

  const load = async () => {
    if (!id) return;
    setLoading(true);
    const r = await fetch(`/api/legal/bgm/meetings/${id}`);
    if (r.ok) {
      const data = await r.json();
      setMeeting(data.meeting);
      setRegister(data.register || []);
      setGuests(data.guests || []);
      setQuorum(data.quorum || 0);
    }
    setLoading(false);
    setDirty(false);
  };
  useEffect(() => { if (id) load(); /* eslint-disable-next-line */ }, [id]);

  const attended = useMemo(
    () => register.filter((r) => r.status === 'present' || r.status === 'virtual').length,
    [register]
  );
  const quorumMet = attended >= quorum && quorum > 0;

  const setDirField = (directorId: string, field: string, value: any) => {
    setRegister((prev) => prev.map((r) => (r.director_id === directorId ? { ...r, [field]: value } : r)));
    setDirty(true);
  };
  const setGuestField = (guestId: string, field: string, value: any) => {
    setGuests((prev) => prev.map((g) => (g.id === guestId ? { ...g, [field]: value } : g)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const entries = [
        ...register.map((r) => ({ kind: 'director', id: r.director_id, status: r.status, note: r.note || null })),
        ...guests.map((g) => ({ kind: 'guest', id: g.id, status: g.status, note: g.note || null })),
      ];
      const res = await fetch(`/api/legal/bgm/attendance/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 207) throw new Error(data.error || 'Failed to save');
      addToast({ type: 'success', message: 'Attendance saved.' });
      load();
    } catch (err) { addToast({ type: 'error', message: (err as Error).message }); }
    finally { setSaving(false); }
  };

  const sendInvites = async () => {
    setInviting(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${id}/invite`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send invitations');
      const via = data.transport === 'outlook' ? 'Outlook' : 'email (.ics)';
      addToast({ type: 'success', message: `Invitations sent via ${via} to ${data.invited} invitee(s)${data.missing_emails ? `; ${data.missing_emails} missing an email` : ''}.` });
      load();
    } catch (err) { addToast({ type: 'error', message: (err as Error).message }); }
    finally { setInviting(false); }
  };

  const cancelMeeting = async () => {
    setCancelling(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${id}`, { method: 'DELETE' });
      if (res.ok) { addToast({ type: 'success', message: 'Meeting cancelled.' }); setCancelOpen(false); load(); }
      else addToast({ type: 'error', message: 'Failed to cancel meeting.' });
    } finally { setCancelling(false); }
  };

  const doFinalize = async (signature: string) => {
    setFinalizing(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${id}/finalize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finalize: true, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to finalize');
      addToast({ type: 'success', message: `Register finalized. Quorum ${data.quorum?.met ? 'met' : 'not met'} (${data.quorum?.attended}/${data.quorum?.required}).` });
      setFinalizeOpen(false);
      load();
    } catch (err) { addToast({ type: 'error', message: (err as Error).message }); }
    finally { setFinalizing(false); }
  };

  const reopenRegister = async () => {
    const res = await fetch(`/api/legal/bgm/meetings/${id}/finalize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finalize: false }),
    });
    if (res.ok) { addToast({ type: 'success', message: 'Register re-opened for editing.' }); load(); }
    else addToast({ type: 'error', message: 'Failed to re-open the register.' });
  };

  const openQr = async () => {
    const res = await fetch(`/api/legal/bgm/meetings/${id}/checkin-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (res.ok) setQrUrl(data.url);
    else addToast({ type: 'error', message: data.error || 'Could not generate QR.' });
  };

  const removeInvitee = async (kind: 'director' | 'guest', keyId: string) => {
    const qs = kind === 'director' ? `director_id=${keyId}` : `guest_id=${keyId}`;
    const res = await fetch(`/api/legal/bgm/meetings/${id}/invitees?${qs}`, { method: 'DELETE' });
    if (res.ok) load(); else addToast({ type: 'error', message: 'Failed to remove.' });
  };

  if (loading) return <AppLayout title="Meeting"><div className="py-24 flex justify-center"><Loader /></div></AppLayout>;
  if (!meeting) return <AppLayout title="Meeting"><div className="max-w-3xl mx-auto p-8 text-center text-neutral-500">Meeting not found.</div></AppLayout>;

  const invitedDirIds = new Set(register.map((r) => r.director_id));

  return (
    <AppLayout title={meeting.title}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/legal/board" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Board Governance
        </Link>

        {/* Meeting header */}
        <Card variant="default" padding="lg" className="mb-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-text-primary">{meeting.title}</h1>
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${meeting.status === 'cancelled' ? 'bg-neutral-100 text-neutral-500' : meeting.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>{meeting.status}</span>
                {finalized && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-50 text-indigo-700"><Lock className="w-3 h-3" /> Finalized</span>}
              </div>
              <div className="mt-2 space-y-1 text-sm text-neutral-600">
                <p className="flex items-center gap-2"><CalendarClock className="w-4 h-4 text-neutral-400" /> {fmtRange(meeting.scheduled_start, meeting.scheduled_end, meeting.time_zone)}</p>
                {meeting.is_virtual ? (
                  <p className="flex items-center gap-2"><Video className="w-4 h-4 text-neutral-400" /> {meeting.virtual_platform ? VIRTUAL_PLATFORM_LABELS[meeting.virtual_platform as keyof typeof VIRTUAL_PLATFORM_LABELS] : 'Virtual'} {meeting.virtual_link && <a href={meeting.virtual_link} target="_blank" rel="noreferrer" className="text-primary-600 hover:underline">· Join link</a>}</p>
                ) : meeting.location ? (
                  <p className="flex items-center gap-2"><MapPin className="w-4 h-4 text-neutral-400" /> {meeting.location}</p>
                ) : null}
                <p className="text-neutral-500">{meeting.meeting_type === 'committee' && meeting.committee?.name ? meeting.committee.name : 'Full Board'} · {register.length} directors{guests.length ? ` · ${guests.length} guests` : ''}</p>
              </div>
              {meeting.agenda && <div className="mt-3 text-sm text-neutral-600"><p className="font-medium text-neutral-700">Agenda</p><p className="whitespace-pre-wrap">{meeting.agenda}</p></div>}
            </div>

            {canManageMeeting && meeting.status !== 'cancelled' && (
              <div className="flex flex-col gap-2 w-full sm:w-auto">
                {!finalized && (
                  <Button variant="primary" onClick={sendInvites} isLoading={inviting}>
                    <Send className="w-4 h-4 mr-1.5" /> {meeting.invitations_sent_at ? 'Resend invitations' : 'Send Outlook invitations'}
                  </Button>
                )}
                {canManageAttendance && (
                  <Button variant={finalized ? 'outline' : 'secondary'} onClick={() => (finalized ? reopenRegister() : setFinalizeOpen(true))}>
                    {finalized ? <><LockOpen className="w-4 h-4 mr-1.5" /> Re-open register</> : <><Lock className="w-4 h-4 mr-1.5" /> Finalize register</>}
                  </Button>
                )}
                {!finalized && <Button variant="outline" onClick={() => setCancelOpen(true)}><Ban className="w-4 h-4 mr-1.5" /> Cancel meeting</Button>}
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            {meeting.invitations_sent_at && <span className="text-emerald-600">Invitations sent {new Date(meeting.invitations_sent_at).toLocaleDateString()}{meeting.outlook_web_link && <> · <a href={meeting.outlook_web_link} target="_blank" rel="noreferrer" className="underline">Outlook</a></>}</span>}
            {meeting.invitations_scheduled_for && !meeting.invitations_sent_at && <span className="text-sky-600">Invitations scheduled for {new Date(meeting.invitations_scheduled_for).toLocaleString()}</span>}
          </div>
        </Card>

        {/* Quorum + save bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-text-primary">Attendance register</h2>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${quorumMet ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
              <ShieldCheck className="w-3.5 h-3.5" /> Quorum {attended}/{quorum} {quorumMet ? '— met' : '— not met'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/legal/board/meetings/${id}/report`}>
              <Button variant="outline"><FileText className="w-4 h-4 mr-1.5" /> Attendance report</Button>
            </Link>
            {editable && <Button variant="outline" onClick={openQr}><QrCode className="w-4 h-4 mr-1.5" /> QR check-in</Button>}
            {editable && started && <Button variant="outline" onClick={() => setEmailOpen(true)}><Mail className="w-4 h-4 mr-1.5" /> Email check-in links</Button>}
            {editable && <Button variant="outline" onClick={() => setAddOpen(true)}><UserPlus className="w-4 h-4 mr-1.5" /> Add attendees</Button>}
            {editable && <Button variant="primary" onClick={save} isLoading={saving} disabled={!dirty}><Save className="w-4 h-4 mr-1.5" /> Save</Button>}
          </div>
        </div>

        {/* Directors register */}
        <Card variant="default" padding="none" className="overflow-hidden mb-6">
          <div className="divide-y divide-border">
            {register.map((r) => (
              <AttendeeRow
                key={r.director_id}
                name={r.full_name} email={r.email}
                status={r.status} signature={r.check_in_signature}
                checkedInAt={r.checked_in_at} method={r.check_in_method}
                editable={editable}
                onStatus={(v) => setDirField(r.director_id, 'status', v)}
                onSign={editable ? () => setSignFor({ id: r.director_id, kind: 'director', name: r.full_name }) : undefined}
                onRemove={editable ? () => removeInvitee('director', r.director_id) : undefined}
                href={`/legal/board/directors/${r.director_id}`}
              />
            ))}
            {register.length === 0 && <div className="px-4 py-8 text-center text-sm text-neutral-500">No directors invited.</div>}
          </div>
        </Card>

        {/* Guests */}
        {guests.length > 0 && (
          <>
            <h3 className="text-sm font-semibold text-text-primary mb-2">Other attendees (non-board)</h3>
            <Card variant="default" padding="none" className="overflow-hidden">
              <div className="divide-y divide-border">
                {guests.map((g) => (
                  <AttendeeRow
                    key={g.id}
                    name={g.full_name} email={g.email} sub={g.role || g.organization}
                    status={g.status} signature={g.check_in_signature}
                    checkedInAt={g.checked_in_at} method={null}
                    editable={editable}
                    onStatus={(v) => setGuestField(g.id, 'status', v)}
                    onSign={editable ? () => setSignFor({ id: g.id, kind: 'guest', name: g.full_name }) : undefined}
                    onRemove={editable ? () => removeInvitee('guest', g.id) : undefined}
                  />
                ))}
              </div>
            </Card>
          </>
        )}
      </div>

      {addOpen && (
        <AddAttendeesModal
          meetingId={String(id)}
          excludedDirectorIds={invitedDirIds}
          onClose={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); load(); }}
        />
      )}

      {qrUrl && <QrCheckInModal meetingId={String(id)} url={qrUrl} title={meeting.title} onClose={() => setQrUrl(null)} />}

      {signFor && (
        <SignatureCaptureModal
          meetingId={String(id)}
          attendee={signFor}
          onClose={() => setSignFor(null)}
          onSaved={() => { setSignFor(null); load(); }}
        />
      )}

      {emailOpen && (
        <AttendanceEmailModal
          meetingId={String(id)}
          register={register}
          guests={guests}
          onClose={() => setEmailOpen(false)}
          onSent={() => setEmailOpen(false)}
        />
      )}

      {finalizeOpen && (
        <SignPromptModal
          title="Finalize the register"
          subtitle="Finalizing locks the attendance record for the minute book. Sign below to confirm — your signature appears on the report."
          confirmLabel="Sign & finalize"
          busy={finalizing}
          onSubmit={doFinalize}
          onClose={() => setFinalizeOpen(false)}
        />
      )}

      <ConfirmDialog
        isOpen={cancelOpen}
        title="Cancel this meeting?"
        message={meeting.invitations_sent_at
          ? 'Invited attendees will be notified that the meeting is cancelled (if an Outlook invitation was sent). The attendance register is kept.'
          : 'The meeting will be marked cancelled. The attendance register is kept.'}
        confirmLabel="Cancel meeting"
        cancelLabel="Keep meeting"
        busy={cancelling}
        onConfirm={cancelMeeting}
        onCancel={() => setCancelOpen(false)}
      />
    </AppLayout>
  );
}

// Two-bucket attendance: Present (covers legacy 'virtual') vs Apology / Absent.
type AttBucket = 'present' | 'absent';
function bucketOf(status: AttendanceStatus | null): AttBucket | null {
  if (status === 'present' || status === 'virtual') return 'present';
  if (status === 'apology' || status === 'absent') return 'absent';
  return null;
}
const ATT_BUCKETS: { key: AttBucket; label: string; value: AttendanceStatus; active: string }[] = [
  { key: 'present', label: 'Present', value: 'present', active: 'border-emerald-500 bg-emerald-50 text-emerald-700' },
  { key: 'absent', label: 'Apology / Absent', value: 'absent', active: 'border-rose-500 bg-rose-50 text-rose-700' },
];

/** One attendee row with a two-option attendance control + signature. */
function AttendeeRow(props: {
  name: string; email?: string | null; sub?: string | null;
  status: AttendanceStatus | null; signature?: string | null;
  checkedInAt?: string | null; method?: string | null;
  editable: boolean; href?: string;
  onStatus: (v: AttendanceStatus | null) => void;
  onSign?: () => void;
  onRemove?: () => void;
}) {
  const bucket = bucketOf(props.status);
  const nameEl = props.href ? (
    <Link href={props.href} className="font-medium text-text-primary hover:text-primary-600">{props.name}</Link>
  ) : <span className="font-medium text-text-primary">{props.name}</span>;
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Signature beside the name */}
          {props.signature && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={props.signature} alt={`${props.name} signature`} className="h-9 w-24 object-contain rounded border border-neutral-200 bg-white shrink-0" />
          )}
          <div className="min-w-0">
            {nameEl}
            <p className="text-xs text-neutral-400 truncate">{props.sub || props.email || '—'}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ATT_BUCKETS.map((b) => (
            <button key={b.key} disabled={!props.editable}
              onClick={() => props.onStatus(bucket === b.key ? null : b.value)}
              className={`px-3 py-1 rounded-md text-xs font-medium border disabled:opacity-60 disabled:cursor-not-allowed ${bucket === b.key ? b.active : 'border-gray-200 text-neutral-500 hover:bg-neutral-50'}`}>
              {b.label}
            </button>
          ))}
          {props.onSign && (
            <button onClick={props.onSign} title={props.signature ? 'Re-capture signature' : 'Sign on this device'}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-primary-300 text-primary-700 hover:bg-primary-50">
              <PenLine className="w-3.5 h-3.5" /> Sign
            </button>
          )}
          {props.onRemove && (
            <button onClick={props.onRemove} className="p-1 text-neutral-300 hover:text-rose-500" title="Remove attendee"><X className="w-4 h-4" /></button>
          )}
        </div>
      </div>
      {props.checkedInAt && (
        <p className="mt-1 text-[11px] text-emerald-600">
          Checked in {fmtTime(props.checkedInAt)}{props.method ? ` · ${CHECK_IN_METHOD_LABELS[props.method] || props.method}` : ''}
        </p>
      )}
    </div>
  );
}

function AddAttendeesModal({ meetingId, excludedDirectorIds, onClose, onAdded }: {
  meetingId: string; excludedDirectorIds: Set<string>; onClose: () => void; onAdded: () => void;
}) {
  const { addToast } = useToast();
  const [directors, setDirectors] = useState<any[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [guests, setGuests] = useState<Associate[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/legal/bgm/directors').then((r) => r.ok ? r.json() : { directors: [] }).then((d) => {
      setDirectors((d.directors || []).filter((x: any) => x.status === 'active' && !excludedDirectorIds.has(x.id)));
    });
    // eslint-disable-next-line
  }, []);

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const submit = async () => {
    if (picked.size === 0 && guests.length === 0) return addToast({ type: 'error', message: 'Pick someone to add.' });
    setSaving(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${meetingId}/invitees`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          director_ids: Array.from(picked),
          guests: guests.map((g) => ({ full_name: g.name, email: g.email || null, app_user_id: g.id || null })),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      addToast({ type: 'success', message: 'Attendees added.' });
      onAdded();
    } catch (err) { addToast({ type: 'error', message: (err as Error).message }); }
    finally { setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title="Add attendees" size="lg">
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Board members not yet invited</p>
          {directors.length === 0 ? (
            <p className="text-sm text-neutral-500">All active directors are already invited.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1 rounded-xl border border-gray-200 p-2">
              {directors.map((d) => (
                <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                  <span className="text-sm text-gray-800">{d.full_name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <AssociatesField label="Other attendees (non-board)" value={guests} onChange={setGuests} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={saving}>Add</Button>
        </div>
      </div>
    </Modal>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
