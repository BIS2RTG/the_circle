import { useMemo, useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { Mail } from 'lucide-react';

interface Row { id: string; kind: 'director' | 'guest'; name: string; email: string | null }

/**
 * Select attendees and email each a PERSONALISED self check-in link so they can
 * sign for attendance themselves. Only attendees with an email can be selected.
 */
export default function AttendanceEmailModal({
  meetingId, register, guests, onClose, onSent,
}: {
  meetingId: string;
  register: any[];
  guests: any[];
  onClose: () => void;
  onSent: () => void;
}) {
  const { addToast } = useToast();
  const [sending, setSending] = useState(false);

  const rows: Row[] = useMemo(() => ([
    ...register.map((r) => ({ id: r.director_id, kind: 'director' as const, name: r.full_name, email: r.email })),
    ...guests.map((g) => ({ id: g.id, kind: 'guest' as const, name: g.full_name, email: g.email })),
  ]), [register, guests]);

  const emailable = rows.filter((r) => !!r.email);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(emailable.map((r) => `${r.kind}:${r.id}`)));

  const toggle = (key: string) => setPicked((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const send = async () => {
    const director_ids = emailable.filter((r) => r.kind === 'director' && picked.has(`director:${r.id}`)).map((r) => r.id);
    const guest_ids = emailable.filter((r) => r.kind === 'guest' && picked.has(`guest:${r.id}`)).map((r) => r.id);
    if (director_ids.length + guest_ids.length === 0) { addToast({ type: 'error', message: 'Select at least one attendee.' }); return; }
    setSending(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${meetingId}/attendance-emails`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ director_ids, guest_ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send');
      addToast({ type: 'success', message: `Attendance link sent to ${data.sent} member(s)${data.missing ? `; ${data.missing} without an email skipped` : ''}.` });
      onSent();
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Email self check-in links" size="md">
      <div>
        <p className="text-sm text-neutral-500 mb-3">
          Each selected member gets their own personalised link to sign for attendance. Links are time-limited and can be used once.
        </p>

        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-neutral-500">{picked.size} selected</span>
          <div className="flex gap-2 text-xs">
            <button className="text-primary-600 hover:underline" onClick={() => setPicked(new Set(emailable.map((r) => `${r.kind}:${r.id}`)))}>Select all</button>
            <button className="text-neutral-500 hover:underline" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto rounded-xl border border-gray-200 divide-y divide-gray-100">
          {rows.map((r) => {
            const key = `${r.kind}:${r.id}`;
            const disabled = !r.email;
            return (
              <label key={key} className={`flex items-center justify-between gap-2 px-3 py-2.5 ${disabled ? 'opacity-50' : 'cursor-pointer hover:bg-gray-50'}`}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <input type="checkbox" disabled={disabled} checked={picked.has(key)} onChange={() => toggle(key)}
                    className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800 truncate">{r.name}</p>
                    <p className="text-xs text-neutral-400 truncate">{r.email || 'No email on file'}</p>
                  </div>
                </div>
                {r.kind === 'guest' && <span className="text-[10px] uppercase text-neutral-400">guest</span>}
              </label>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button variant="primary" onClick={send} isLoading={sending}><Mail className="w-4 h-4 mr-1.5" /> Send links</Button>
        </div>
      </div>
    </Modal>
  );
}
