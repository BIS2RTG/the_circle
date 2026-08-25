import { useMemo, useState } from 'react';
import { Modal, Button, Input } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { AssociatesField, Associate } from '../../requests/AssociatesField';
import { MeetingType, VIRTUAL_PLATFORMS, VIRTUAL_PLATFORM_LABELS, VirtualPlatform, platformNeedsManualLink } from '../../../lib/bgm';
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
  const [formError, setFormError] = useState<string | null>(null);

  const [pastMode, setPastMode] = useState(false);
  const [type, setType] = useState<MeetingType>('board');
  // A committee meeting can span one OR several committees; the members of every
  // selected committee are invited (union).
  const [committeeIds, setCommitteeIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('11:00');
  const [location, setLocation] = useState('');
  const [isVirtual, setIsVirtual] = useState(false);
  const [platform, setPlatform] = useState<VirtualPlatform>('zoom');
  const [virtualLink, setVirtualLink] = useState('');
  const [agenda, setAgenda] = useState('');

  const [inviteMode, setInviteMode] = useState<InviteMode>('all');
  const [selectedDirs, setSelectedDirs] = useState<Set<string>>(new Set());
  const [guests, setGuests] = useState<Associate[]>([]);

  const [sendMode, setSendMode] = useState<SendMode>('manual');
  const [sendAt, setSendAt] = useState('');

  // Local (not UTC) yyyy-mm-dd for the date input's min/max bounds.
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const activeDirectors = useMemo(() => directors.filter((d) => d.status === 'active'), [directors]);
  const activeDirectorIds = useMemo(() => new Set(activeDirectors.map((d) => d.id)), [activeDirectors]);
  const committeeOptions = committees.filter((c) => !c.is_main_board);

  // The active-director ids that make up a committee (committee members who are
  // no longer active are ignored — they can't be invited).
  const committeeMemberIds = (committeeId: string): string[] => {
    const c = committees.find((x) => x.id === committeeId);
    return (c?.members || []).map((m) => m.id).filter((mid) => activeDirectorIds.has(mid));
  };

  // Directors implied by the current scope — all board members, or (for a
  // committee meeting) the UNION of every selected committee's members. Used for
  // the "All committee members" count.
  const scopeDirectorIds = useMemo(() => {
    if (type === 'committee') {
      // Union of the selected committees' members (empty until one is picked).
      const s = new Set<string>();
      for (const cid of committeeIds) committeeMemberIds(cid).forEach((mid) => s.add(mid));
      return s;
    }
    return new Set(activeDirectors.map((d) => d.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, committeeIds, committees, activeDirectors]);

  // The final invitee set. null → let the server apply the base scope default
  // (all board / all committee). In custom mode we always send the explicit set
  // — even when empty — so the server never silently falls back to "everyone".
  const finalInviteeIds = useMemo<Set<string> | null>(() => {
    if (inviteMode === 'custom') return selectedDirs;
    return null;
  }, [inviteMode, selectedDirs]);

  const inviteeCount = inviteMode === 'custom' ? selectedDirs.size : scopeDirectorIds.size;

  const reset = () => {
    setPastMode(false); setType('board'); setCommitteeIds(new Set()); setTitle(''); setDate('');
    setStartTime('09:00'); setEndTime('11:00'); setLocation(''); setIsVirtual(false);
    setPlatform('zoom'); setVirtualLink(''); setAgenda(''); setInviteMode('all'); setSelectedDirs(new Set());
    setGuests([]); setSendMode('manual'); setSendAt('');
  };

  const toggleCommitteePick = (id: string) => {
    setCommitteeIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleClose = () => { if (!saving) { reset(); onClose(); } };

  // "Choose specific members" starts from a blank slate so the invite is exactly
  // who the legal team ticks — no board member is invited unless explicitly picked.
  const enterCustom = () => {
    setInviteMode('custom');
    setSelectedDirs(new Set());
  };
  const toggleDir = (id: string) => {
    setInviteMode('custom');
    setSelectedDirs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Clicking a committee pulls exactly that committee's members into the custom
  // selection (toggling them off again if they're all already picked). This is
  // how "click the Tech committee → invite only its members" works.
  const isCommitteeFullyPicked = (committeeId: string): boolean => {
    const ids = committeeMemberIds(committeeId);
    return ids.length > 0 && inviteMode === 'custom' && ids.every((mid) => selectedDirs.has(mid));
  };
  const toggleCommittee = (committeeId: string) => {
    const ids = committeeMemberIds(committeeId);
    if (ids.length === 0) return;
    setInviteMode('custom');
    setSelectedDirs((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((mid) => next.has(mid));
      if (allIn) ids.forEach((mid) => next.delete(mid));
      else ids.forEach((mid) => next.add(mid));
      return next;
    });
  };

  const submit = async () => {
    setFormError(null);
    if (!title.trim()) return setFormError('Please enter a meeting title.');
    if (!date) return setFormError('Please choose a date.');
    if (type === 'committee' && committeeIds.size === 0) return setFormError('Please select at least one committee.');

    const start = new Date(`${date}T${startTime}`);
    const end = new Date(`${date}T${endTime}`);
    if (isNaN(start.getTime())) return setFormError('That date or time is not valid.');
    if (!pastMode && start.getTime() < Date.now()) {
      return setFormError('That date/time is in the past. Switch to “Record a past meeting” to backfill attendance.');
    }
    if (pastMode && start.getTime() > Date.now()) {
      return setFormError('A past meeting must have a date/time that has already occurred. Switch to “Upcoming meeting” to schedule a future one.');
    }

    const director_ids = finalInviteeIds ? Array.from(finalInviteeIds) : undefined;
    if (director_ids && director_ids.length === 0 && guests.length === 0) {
      return setFormError('Select at least one director or guest to invite.');
    }

    let invitations_scheduled_for: string | undefined;
    if (!pastMode && sendMode === 'schedule') {
      if (!sendAt) return setFormError('Choose when to send the invitations.');
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
          committee_id: type === 'committee' ? (Array.from(committeeIds)[0] || null) : null,
          committee_ids: type === 'committee' ? Array.from(committeeIds) : undefined,
          scheduled_start: start.toISOString(),
          scheduled_end: end > start ? end.toISOString() : null,
          location: location || null,
          is_virtual: isVirtual,
          virtual_platform: isVirtual ? platform : null,
          virtual_link: isVirtual ? virtualLink || null : null,
          agenda: agenda || null,
          director_ids,
          guests: guests.map((g) => ({ full_name: g.name, email: g.email || null, app_user_id: g.id || null })),
          invitations_scheduled_for,
          record_only: pastMode,
        }),
      });
      // The API always answers JSON; if the body doesn't parse it means the
      // request never reached the handler (e.g. an auth/edge error returning an
      // HTML page) — surface a readable message instead of a raw JSON-parse error.
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error(
          (data && data.error) ||
            `Could not schedule the meeting (server responded ${res.status}). Please try again, or contact support if it persists.`
        );
      }

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
      setFormError((err as Error).message);
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Committees <span className="text-gray-400 font-normal">(select one or more)</span>
            </label>
            {committeeOptions.length === 0 ? (
              <p className="text-sm text-gray-500">No committees have been set up yet.</p>
            ) : (
              <div className="rounded-xl border border-gray-300 divide-y divide-gray-100 max-h-44 overflow-y-auto">
                {committeeOptions.map((c) => {
                  const on = committeeIds.has(c.id);
                  const count = committeeMemberIds(c.id).length;
                  return (
                    <label key={c.id} className={`flex items-center gap-2 px-3 py-2 cursor-pointer ${on ? 'bg-primary-50' : 'hover:bg-gray-50'}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleCommitteePick(c.id)}
                        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                      <span className="text-sm text-gray-800 flex-1">{c.name}</span>
                      <span className="text-xs text-gray-400">{count} member{count === 1 ? '' : 's'}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {committeeIds.size > 1 && (
              <p className="text-xs text-gray-500 mt-1.5">
                {committeeIds.size} committees selected — members of all of them will be invited.
              </p>
            )}
          </div>
        )}

        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Q3 Board Meeting" />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
            min={pastMode ? undefined : todayStr} max={pastMode ? todayStr : undefined} />
          <Input label="Start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <Input label="End" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>

        <div className="flex items-center gap-2">
          <input id="is-virtual" type="checkbox" checked={isVirtual} onChange={(e) => setIsVirtual(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
          <label htmlFor="is-virtual" className="text-sm text-gray-700">Virtual / hybrid meeting</label>
        </div>
        {isVirtual && (
          <div className="rounded-xl border border-gray-200 p-3 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
              <div className="grid grid-cols-4 gap-2">
                {VIRTUAL_PLATFORMS.map((p) => (
                  <button key={p} type="button" onClick={() => setPlatform(p)}
                    className={`px-2 py-2 rounded-lg border text-xs font-medium transition-colors ${platform === p ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                    {VIRTUAL_PLATFORM_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>
            <Input
              label={platform === 'teams' ? 'Join link (optional — a Teams link is auto-created if left blank)' : 'Join link'}
              value={virtualLink}
              onChange={(e) => setVirtualLink(e.target.value)}
              placeholder={platform === 'zoom' ? 'Paste the Zoom link created by IT' : platform === 'google_meet' ? 'Paste the Google Meet link' : 'Paste the meeting link'}
            />
            {platform === 'zoom' && (
              <p className="text-[11px] text-gray-500">RTG has a single Zoom licence — ask IT to create the meeting, then paste the link here so it rides on the Outlook invite.</p>
            )}
          </div>
        )}
        <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Boardroom, Head Office" />

        {/* Invitees */}
        <div className="border-t border-border pt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">{pastMode ? 'Who was invited?' : 'Who is invited?'}</label>
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
              {/* Quick-add a whole committee. Clicking a committee ticks exactly
                  its members (and un-ticks them if they're all already picked). */}
              {committeeOptions.length > 0 && (
                <div className="mb-3 pb-3 border-b border-gray-100">
                  <p className="text-xs text-gray-500 mb-1.5">Add everyone from a committee</p>
                  <div className="flex flex-wrap gap-1.5">
                    {committeeOptions.map((c) => {
                      const count = committeeMemberIds(c.id).length;
                      const on = isCommitteeFullyPicked(c.id);
                      return (
                        <button key={c.id} type="button" onClick={() => toggleCommittee(c.id)} disabled={count === 0}
                          title={count === 0 ? 'This committee has no active members' : `Invite the ${count} member${count === 1 ? '' : 's'} of ${c.name}`}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${on ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                          {on && <UserCheck className="w-3.5 h-3.5" />}{c.name}{count ? ` (${count})` : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
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

          <p className="text-xs text-gray-500 mb-3">
            {pastMode ? (
              <><b className="text-gray-700">{inviteeCount}</b> member{inviteeCount === 1 ? '' : 's'} who {inviteeCount === 1 ? 'was' : 'were'} invited{guests.length ? ` · ${guests.length} guest${guests.length === 1 ? '' : 's'}` : ''}.</>
            ) : (
              <><b className="text-gray-700">{inviteeCount}</b> board / committee member{inviteeCount === 1 ? '' : 's'} will be invited{guests.length ? ` · ${guests.length} guest${guests.length === 1 ? '' : 's'}` : ''}.</>
            )}
          </p>

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

        {formError && (
          <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{formError}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} isLoading={saving}>{pastMode ? 'Record meeting' : 'Schedule meeting'}</Button>
        </div>
      </div>
    </Modal>
  );
}
