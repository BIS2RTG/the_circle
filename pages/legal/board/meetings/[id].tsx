import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]';
import { getUserRBACProfile, hasAnyPermission } from '@/lib/rbac';
import { AppLayout } from '../../../../components/layout';
import { Card, Button, Modal } from '../../../../components/ui';
import ConfirmDialog from '../../../../components/ui/ConfirmDialog';
import Loader from '@/components/Loader';
import { useToast } from '../../../../components/ui/ToastProvider';
import { useRBAC } from '../../../../contexts/RBACContext';
import { AssociatesField, Associate } from '../../../../components/requests/AssociatesField';
import {
  ATTENDANCE_STATUSES, ATTENDANCE_LABELS, AttendanceStatus,
  RSVP_STATUSES, RSVP_LABELS, RsvpStatus, CHECK_IN_METHOD_LABELS, VIRTUAL_PLATFORM_LABELS,
} from '@/lib/bgm';
import QrCheckInModal from '../../../../components/legal/bgm/QrCheckInModal';
import { ArrowLeft, MapPin, Video, CalendarClock, Send, Ban, Save, Lock, LockOpen, UserPlus, X, ShieldCheck, QrCode, FileText } from 'lucide-react';

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

  const finalized = !!meeting?.finalized_at;
  const editable = canManageAttendance && !finalized && meeting?.status !== 'cancelled';

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
        ...register.map((r) => ({ kind: 'director', id: r.director_id, status: r.status, rsvp_status: r.rsvp_status, note: r.note || null })),
        ...guests.map((g) => ({ kind: 'guest', id: g.id, status: g.status, rsvp_status: g.rsvp_status, note: g.note || null })),
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

  const toggleFinalize = async () => {
    const res = await fetch(`/api/legal/bgm/meetings/${id}/finalize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finalize: !finalized }),
    });
    const data = await res.json();
    if (res.ok) {
      addToast({ type: 'success', message: finalized ? 'Register re-opened for editing.' : `Register finalized. Quorum ${data.quorum?.met ? 'met' : 'not met'} (${data.quorum?.attended}/${data.quorum?.required}).` });
      load();
    } else addToast({ type: 'error', message: data.error || 'Failed' });
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
                  <Button variant={finalized ? 'outline' : 'secondary'} onClick={toggleFinalize}>
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
                rsvp={r.rsvp_status} status={r.status} note={r.note}
                checkedInAt={r.checked_in_at} method={r.check_in_method}
                editable={editable}
                onRsvp={(v) => setDirField(r.director_id, 'rsvp_status', v)}
                onStatus={(v) => setDirField(r.director_id, 'status', v)}
                onNote={(v) => setDirField(r.director_id, 'note', v)}
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
                    rsvp={g.rsvp_status} status={g.status} note={g.note}
                    checkedInAt={g.checked_in_at} method={null}
                    editable={editable}
                    onRsvp={(v) => setGuestField(g.id, 'rsvp_status', v)}
                    onStatus={(v) => setGuestField(g.id, 'status', v)}
                    onNote={(v) => setGuestField(g.id, 'note', v)}
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

/** One attendee row with RSVP + attendance segmented controls. */
function AttendeeRow(props: {
  name: string; email?: string | null; sub?: string | null;
  rsvp: RsvpStatus; status: AttendanceStatus | null; note?: string | null;
  checkedInAt?: string | null; method?: string | null;
  editable: boolean; href?: string;
  onRsvp: (v: RsvpStatus) => void; onStatus: (v: AttendanceStatus | null) => void; onNote: (v: string) => void;
  onRemove?: () => void;
}) {
  const nameEl = props.href ? (
    <Link href={props.href} className="font-medium text-text-primary hover:text-primary-600">{props.name}</Link>
  ) : <span className="font-medium text-text-primary">{props.name}</span>;
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {nameEl}
          <p className="text-xs text-neutral-400 truncate">{props.sub || props.email || '—'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {/* RSVP */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wider text-neutral-400 mr-1">RSVP</span>
            {RSVP_STATUSES.filter((s) => s !== 'no_response').map((s) => (
              <button key={s} disabled={!props.editable}
                onClick={() => props.onRsvp(props.rsvp === s ? 'no_response' : s)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium border disabled:opacity-60 disabled:cursor-not-allowed ${props.rsvp === s ? rsvpClass(s) : 'border-gray-200 text-neutral-500 hover:bg-neutral-50'}`}>
                {RSVP_LABELS[s]}
              </button>
            ))}
          </div>
          {/* Attendance */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wider text-neutral-400 mr-1">Present</span>
            {ATTENDANCE_STATUSES.map((s) => (
              <button key={s} disabled={!props.editable}
                onClick={() => props.onStatus(props.status === s ? null : s)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium border disabled:opacity-60 disabled:cursor-not-allowed ${props.status === s ? attClass(s) : 'border-gray-200 text-neutral-500 hover:bg-neutral-50'}`}>
                {ATTENDANCE_LABELS[s]}
              </button>
            ))}
          </div>
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

function rsvpClass(s: RsvpStatus): string {
  switch (s) {
    case 'accepted': return 'border-emerald-500 bg-emerald-50 text-emerald-700';
    case 'declined': return 'border-rose-500 bg-rose-50 text-rose-700';
    case 'tentative': return 'border-amber-500 bg-amber-50 text-amber-700';
    default: return 'border-gray-200 text-neutral-500';
  }
}
function attClass(s: AttendanceStatus): string {
  switch (s) {
    case 'present': return 'border-emerald-500 bg-emerald-50 text-emerald-700';
    case 'virtual': return 'border-sky-500 bg-sky-50 text-sky-700';
    case 'apology': return 'border-amber-500 bg-amber-50 text-amber-700';
    case 'absent': return 'border-rose-500 bg-rose-50 text-rose-700';
  }
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  const profile = await getUserRBACProfile((session.user as any).id);
  if (!hasAnyPermission(profile, ['bgm.meetings.view', 'bgm.attendance.view', 'legal.access'])) {
    return { redirect: { destination: '/dashboard', permanent: false } };
  }
  return { props: {} };
};
