import { useMemo, useState } from 'react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { Mail } from 'lucide-react';

interface Row { key: string; kind: 'director' | 'guest'; id: string; name: string; email: string | null; status: string | null }

const STATUS_OPTIONS: { value: string; label: string; active: string }[] = [
  { value: 'present', label: 'Present', active: 'border-emerald-500 bg-emerald-50 text-emerald-700' },
  { value: 'apology', label: 'Apology', active: 'border-amber-500 bg-amber-50 text-amber-700' },
  { value: 'absent', label: 'Absent', active: 'border-rose-500 bg-rose-50 text-rose-700' },
];
const norm = (s: string | null) => (s === 'virtual' ? 'present' : s && ['present', 'apology', 'absent'].includes(s) ? s : '');

/**
 * Select attendees, set each one's attendance status (present / apology / absent),
 * then email each a personalised sign link. Every selected member must have a
 * status before sending — the member's signature acknowledges that status.
 */
export default function AttendanceEmailModal({
  meetingId, register, guests, happened, onClose, onSent,
}: {
  meetingId: string;
  register: any[];
  guests: any[];
  happened?: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const { addToast } = useToast();
  const [sending, setSending] = useState(false);

  const rows: Row[] = useMemo(() => ([
    ...register.map((r) => ({ key: `director:${r.director_id}`, kind: 'director' as const, id: r.director_id, name: r.full_name, email: r.email, status: r.status })),
    ...guests.map((g) => ({ key: `guest:${g.id}`, kind: 'guest' as const, id: g.id, name: g.full_name, email: g.email, status: g.status })),
  ]), [register, guests]);

  const emailable = rows.filter((r) => !!r.email);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(emailable.map((r) => r.key)));
  const [statuses, setStatuses] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const r of rows) { const n = norm(r.status); if (n) init[r.key] = n; }
    return init;
  });

  const toggle = (key: string) => setPicked((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const setStatus = (key: string, value: string) => setStatuses((s) => ({ ...s, [key]: value }));

  const pickedEmailable = emailable.filter((r) => picked.has(r.key));
  const missingStatus = pickedEmailable.filter((r) => !statuses[r.key]).length;

  const send = async () => {
    if (pickedEmailable.length === 0) { addToast({ type: 'error', message: 'Select at least one attendee with an email.' }); return; }
    if (missingStatus > 0) { addToast({ type: 'error', message: `Set an attendance status for all ${missingStatus} remaining member(s) first.` }); return; }
    const targets = pickedEmailable.map((r) => ({ kind: r.kind, id: r.id, status: statuses[r.key] }));
    setSending(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${meetingId}/attendance-emails`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send');
      const extras = [
        data.missing ? `${data.missing} without an email skipped` : '',
        data.failed ? `${data.failed} could not be delivered` : '',
      ].filter(Boolean).join('; ');
      addToast({ type: data.failed ? 'warning' : 'success', message: `Sign link sent to ${data.sent} member(s)${extras ? ` — ${extras}` : ''}.` });
      onSent();
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={happened ? 'Email sign-off links' : 'Email self check-in links'} size="lg">
      <div>
        <p className="text-sm text-neutral-500 mb-3">
          Set each member&apos;s attendance status, then send them a personalised link to sign. Their signature acknowledges the status you set here.
        </p>

        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-neutral-500">{pickedEmailable.length} selected{missingStatus > 0 ? ` · ${missingStatus} need a status` : ''}</span>
          <div className="flex gap-2 text-xs">
            <button className="text-primary-600 hover:underline" onClick={() => setPicked(new Set(emailable.map((r) => r.key)))}>Select all</button>
            <button className="text-neutral-500 hover:underline" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto rounded-xl border border-gray-200 divide-y divide-gray-100">
          {rows.map((r) => {
            const disabled = !r.email;
            const checked = picked.has(r.key);
            return (
              <div key={r.key} className={`px-3 py-2.5 ${disabled ? 'opacity-50' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <label className={`flex items-center gap-2.5 min-w-0 ${disabled ? '' : 'cursor-pointer'}`}>
                    <input type="checkbox" disabled={disabled} checked={checked} onChange={() => toggle(r.key)}
                      className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                    <div className="min-w-0">
                      <p className="text-sm text-gray-800 truncate">{r.name}{r.kind === 'guest' && <span className="ml-1 text-[10px] uppercase text-neutral-400">guest</span>}</p>
                      <p className="text-xs text-neutral-400 truncate">{r.email || 'No email on file'}</p>
                    </div>
                  </label>
                  {checked && !disabled && (
                    <div className="flex gap-1 shrink-0">
                      {STATUS_OPTIONS.map((o) => (
                        <button key={o.value} type="button" onClick={() => setStatus(r.key, o.value)}
                          className={`px-2 py-1 rounded-md text-xs font-medium border transition-colors ${statuses[r.key] === o.value ? o.active : 'border-gray-200 text-neutral-500 hover:bg-neutral-50'}`}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button variant="primary" onClick={send} isLoading={sending} disabled={pickedEmailable.length === 0 || missingStatus > 0}>
            <Mail className="w-4 h-4 mr-1.5" /> Send links
          </Button>
        </div>
      </div>
    </Modal>
  );
}
