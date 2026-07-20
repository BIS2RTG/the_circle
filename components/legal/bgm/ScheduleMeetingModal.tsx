import { useMemo, useState } from 'react';
import { Modal, Button, Input } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { AssociatesField, Associate } from '../../requests/AssociatesField';
import { MeetingType } from '@/lib/bgm';
import { Users, UserCheck, CalendarClock, History } from 'lucide-react';

interface DirectorOption {
  id: string;
  full_name: string;
  status: string;
}
interface CommitteeOption {
  id: string;
  name: string;
  is_main_board: boolean;
  members?: { id: string }[];
}

interface ScheduleMeetingModalProps {
  isOpen: boolean;
  onClose: () => void;
  committees: CommitteeOption[];
  directors: DirectorOption[];
  onCreated: (meetingId: string) => void;
}

type InviteMode = 'all' | 'custom';
type SendMode = 'manual' | 'now' | 'schedule';

export default function ScheduleMeetingModal({ isOpen, onClose, committees, directors, onCreated }: ScheduleMeetingModalProps) {
  const { addToast } = useToast();
  const [saving, setSaving] = useState(false);

  const [pastMode, setPastMode] = useState(false);
  const [type, setType] = useState<MeetingType>('board');
  const [committeeId, setCommitteeId] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('11:00');
  const [location, setLocation] = useState('');
  const [isVirtual, setIsVirtual] = useState(false);
  const [virtualLink, setVirtualLink] = useState('');
  const [agenda, setAgenda] = useState('');

  const [inviteMode, setInviteMode] = useState<InviteMode>('all');
  const [selectedDirs, setSelectedDirs] = useState<Set<string>>(new Set());
  const [guests, setGuests] = useState<Associate[]>([]);

  const [sendMode, setSendMode] = useState<SendMode>('manual');
  const [sendAt, setSendAt] = useState('');

  const activeDirectors = useMemo(() => directors.filter((d) => d.status === 'active'), [directors]);
  const committeeOptions = committees.filter((c) => !c.is_main_board);

  // Directors implied by the current scope (used to pre-fill the custom picker).
  const scopeDirectorIds = useMemo(() => {
    if (type === 'committee' && committeeId) {
      const c = committees.find((x) => x.id === committeeId);
      return new Set((c?.members || []).map((m) => m.id));
    }
    return new Set(activeDirectors.map((d) => d.id));
  }, [type, committeeId, committees, activeDirectors]);

  const reset = () => {
    setPastMode(false); setType('board'); setCommitteeId(''); setTitle(''); setDate('');
    setStartTime('09:00'); setEndTime('11:00'); setLocation(''); setIsVirtual(false);
    setVirtualLink(''); setAgenda(''); setInviteMode('all'); setSelectedDirs(new Set());
    setGuests([]); setSendMode('manual'); setSendAt('');
  };
  const handleClose = () => { if (!saving) { reset(); onClose(); } };

  const enterCustom = () => {
    setInviteMode('custom');
    setSelectedDirs(new Set(scopeDirectorIds)); // seed from scope
  };
  const toggleDir = (id: string) => {
    setSelectedDirs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!title.trim()) return addToast({ type: 'error', message: 'Please enter a meeting title.' });
    if (!date) return addToast({ type: 'error', message: 'Please choose a date.' });
    if (type === 'committee' && !committeeId) return addToast({ type: 'error', message: 'Please select a committee.' });

    const start = new Date(`${date}T${startTime}`);
    const end = new Date(`${date}T${endTime}`);
    if (isNaN(start.getTime())) return addToast({ type: 'error', message: 'Invalid date/time.' });
    if (!pastMode && start.getTime() < Date.now()) {
      return addToast({ type: 'error', message: 'That date is in the past. Use “Record a past meeting” to backfill attendance.' });
    }

    const director_ids = inviteMode === 'custom' ? Array.from(selectedDirs) : undefined;
    if (inviteMode === 'custom' && director_ids && director_ids.length === 0 && guests.length === 0) {
      return addToast({ type: 'error', message: 'Select at least one director or guest.' });
    }

    let invitations_scheduled_for: string | undefined;
    if (!pastMode && sendMode === 'schedule') {
      if (!sendAt) return addToast({ type: 'error', message: 'Choose when to send the invitations.' });
      invitations_scheduled_for = new Date(sendAt).toISOString();
    }

    setSaving(true);
    try {
      const res = await fetch('/api/legal/bgm/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          meeting_type: type,
          committee_id: type === 'committee' ? committeeId : null,
          scheduled_start: start.toISOString(),
          scheduled_end: end > start ? end.toISOString() : null,
          location: location || null,
          is_virtual: isVirtual,
          virtual_link: isVirtual ? virtualLink || null : null,
          agenda: agenda || null,
          director_ids,
          guests: guests.map((g) => ({ full_name: g.name, email: g.email || null, app_user_id: g.id || null })),
          invitations_scheduled_for,
          record_only: pastMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to schedule meeting');

      // Optionally fire invitations immediately.
      if (!pastMode && sendMode === 'now') {
        const inv = await fetch(`/api/legal/bgm/meetings/${data.id}/invite`, { method: 'POST' });
        const invData = await inv.json().catch(() => ({}));
        if (inv.ok) addToast({ type: 'success', message: `Meeting created; invitations sent to ${invData.invited} invitee(s).` });
        else addToast({ type: 'success', message: `Meeting created. Invitations not sent: ${invData.error || 'Outlook unavailable'}` });
      } else {
        addToast({
          type: 'success',
          message: pastMode
            ? `Past meeting recorded with ${data.invitees} director(s) — record their attendance now.`
            : `Meeting scheduled with ${data.invitees} director(s)${data.guests ? ` and ${data.guests} guest(s)` : ''} invited.`,
        });
      }
      reset();
      onCreated(data.id);
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={pastMode ? 'Record a past meeting' : 'Schedule a meeting'} size="lg">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {/* Upcoming vs past */}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setPastMode(false)}
            className={`flex items-center justify-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium ${!pastMode ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            <CalendarClock className="w-4 h-4" /> Upcoming meeting
          </button>
          <button type="button" onClick={() => { setPastMode(true); setSendMode('manual'); }}
            className={`flex items-center justify-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium ${pastMode ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            <History className="w-4 h-4" /> Record a past meeting
          </button>
        </div>
        {pastMode && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            No invitations are sent for past meetings. The register opens immediately so you can transcribe the attendance book.
          </p>
        )}

        {/* Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Meeting type</label>
          <div className="grid grid-cols-2 gap-2">
            {(['board', 'committee'] as MeetingType[]).map((t) => (
              <button key={t} type="button" onClick={() => { setType(t); setInviteMode('all'); }}
                className={`px-4 py-2 rounded-xl border text-sm font-medium transition-colors ${type === t ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {t === 'board' ? 'Board meeting' : 'Committee meeting'}
              </button>
            ))}
          </div>
        </div>

        {type === 'committee' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Committee</label>
            <select value={committeeId} onChange={(e) => setCommitteeId(e.target.value)}
              className="w-full px-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">Select a committee…</option>
              {committeeOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Q3 Board Meeting" />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <Input label="End" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>

        <div className="flex items-center gap-2">
          <input id="is-virtual" type="checkbox" checked={isVirtual} onChange={(e) => setIsVirtual(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
          <label htmlFor="is-virtual" className="text-sm text-gray-700">Virtual / hybrid meeting</label>
        </div>
        {isVirtual && <Input label="Meeting link" value={virtualLink} onChange={(e) => setVirtualLink(e.target.value)} placeholder="Teams / Zoom link" />}
        <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Boardroom, Head Office" />

        {/* Invitees */}
        <div className="border-t border-border pt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">Who is invited?</label>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <button type="button" onClick={() => setInviteMode('all')}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm ${inviteMode === 'all' ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              <Users className="w-4 h-4" /> {type === 'board' ? 'All board members' : 'All committee members'}
            </button>
            <button type="button" onClick={enterCustom}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm ${inviteMode === 'custom' ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              <UserCheck className="w-4 h-4" /> Choose specific members
            </button>
          </div>

          {inviteMode === 'custom' && (
            <div className="rounded-xl border border-gray-200 p-3 mb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">{selectedDirs.size} selected</span>
                <div className="flex gap-2 text-xs">
                  <button type="button" className="text-primary-600 hover:underline" onClick={() => setSelectedDirs(new Set(activeDirectors.map((d) => d.id)))}>Select all</button>
                  <button type="button" className="text-gray-500 hover:underline" onClick={() => setSelectedDirs(new Set())}>Clear</button>
                </div>
              </div>
              <div className="max-h-44 overflow-y-auto space-y-1">
                {activeDirectors.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={selectedDirs.has(d.id)} onChange={() => toggleDir(d.id)}
                      className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                    <span className="text-sm text-gray-800">{d.full_name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Guests — AD directory picker + non-RTG free text */}
          <AssociatesField
            label="Other attendees (non-board)"
            value={guests}
            onChange={setGuests}
          />
        </div>

        {/* Agenda */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Agenda (optional)</label>
          <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={2}
            className="w-full px-4 py-2 rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Key items to be discussed…" />
        </div>

        {/* Invitation timing */}
        {!pastMode && (
          <div className="border-t border-border pt-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Invitations</label>
            <div className="space-y-2">
              {([
                ['manual', "I'll send them manually later"],
                ['now', 'Send Outlook invitations now'],
                ['schedule', 'Schedule invitations for a specific time'],
              ] as [SendMode, string][]).map(([m, label]) => (
                <label key={m} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="radio" name="sendMode" checked={sendMode === m} onChange={() => setSendMode(m)}
                    className="w-4 h-4 text-primary-600 focus:ring-primary-500" />
                  {label}
                </label>
              ))}
            </div>
            {sendMode === 'schedule' && (
              <div className="mt-2">
                <Input label="Send at" type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={saving}>{pastMode ? 'Record meeting' : 'Schedule meeting'}</Button>
        </div>
      </div>
    </Modal>
  );
}
