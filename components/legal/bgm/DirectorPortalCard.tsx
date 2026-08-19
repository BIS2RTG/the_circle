import { useEffect, useState, useCallback } from 'react';
import { Card, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { DIRECTOR_ACTION_LABELS, accessEventLabel } from '@/lib/directorPortal';
import {
  KeyRound, LogIn, UserCog, FileSignature, ClipboardCheck, Copy, Mail, Ban,
  ShieldCheck, Clock, History,
} from 'lucide-react';

function fmtDateTime(iso: string | null) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return '—'; }
}

/**
 * BGM-05/07 admin panel on a director's profile: issue secure single-use links
 * (portal sign-in, update profile, sign a declaration, confirm attendance),
 * revoke active links, and view the director's access audit trail.
 */
export default function DirectorPortalCard({ directorId, canManage }: { directorId: string; canManage: boolean }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [declTarget, setDeclTarget] = useState('');
  const [meetingTarget, setMeetingTarget] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/legal/bgm/directors/${directorId}/links`);
    if (r.ok) setData(await r.json());
    setLoading(false);
  }, [directorId]);
  useEffect(() => { load(); }, [load]);

  const issue = async (action: string, target_id?: string) => {
    if (!canManage) return;
    setBusy(action + (target_id || ''));
    try {
      const r = await fetch(`/api/legal/bgm/directors/${directorId}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, target_id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not issue the link.');
      if (d.emailed) addToast({ type: 'success', message: `${DIRECTOR_ACTION_LABELS[action as keyof typeof DIRECTOR_ACTION_LABELS]} link emailed.` });
      else {
        await navigator.clipboard.writeText(d.url).catch(() => {});
        addToast({ type: 'success', message: 'Link created and copied (no email on file to send it).' });
      }
      load();
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setBusy(null); }
  };

  const revoke = async (tokenId: string) => {
    setBusy('revoke' + tokenId);
    try {
      const r = await fetch(`/api/legal/bgm/directors/${directorId}/links?token_id=${tokenId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || 'Could not revoke.');
      addToast({ type: 'success', message: 'Link revoked.' });
      load();
    } catch (e) { addToast({ type: 'error', message: (e as Error).message }); }
    finally { setBusy(null); }
  };

  if (loading) return null;

  const activeTokens = (data?.tokens || []).filter((t: any) => !t.consumed_at && !t.revoked_at && !t.expired);
  const declarations = data?.targets?.declarations || [];
  const meetings = data?.targets?.meetings || [];

  return (
    <Card variant="default" padding="lg" className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-primary-500" />
        <h2 className="text-sm font-semibold text-text-primary">Secure links &amp; portal access</h2>
      </div>
      <p className="text-xs text-neutral-500 mb-4">
        Single-use, time-limited links (default {data?.default_days ?? 7} days). Every access is recorded in the audit trail below.
        {!data?.hasEmail && <span className="text-amber-600"> No email on file — links are created and copied, not emailed.</span>}
      </p>

      {canManage && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
          <IssueButton icon={<LogIn className="w-4 h-4" />} label="Send portal sign-in" busy={busy === 'portal_login'} onClick={() => issue('portal_login')} />
          <IssueButton icon={<UserCog className="w-4 h-4" />} label="Send profile-update link" busy={busy === 'update_profile'} onClick={() => issue('update_profile')} />

          <div className="flex gap-2">
            <select value={declTarget} onChange={(e) => setDeclTarget(e.target.value)}
              className="flex-1 px-2.5 py-2 rounded-lg border border-gray-200 bg-white text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">Declaration…</option>
              {declarations.map((d: any) => <option key={d.id} value={d.id}>{d.label}{d.period_year ? ` (${d.period_year})` : ''}</option>)}
            </select>
            <Button variant="outline" size="sm" disabled={!declTarget || busy === 'sign_declaration' + declTarget} onClick={() => issue('sign_declaration', declTarget)}>
              <FileSignature className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex gap-2">
            <select value={meetingTarget} onChange={(e) => setMeetingTarget(e.target.value)}
              className="flex-1 px-2.5 py-2 rounded-lg border border-gray-200 bg-white text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">Meeting…</option>
              {meetings.map((m: any) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
            <Button variant="outline" size="sm" disabled={!meetingTarget || busy === 'confirm_attendance' + meetingTarget} onClick={() => issue('confirm_attendance', meetingTarget)}>
              <ClipboardCheck className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Active links */}
      {activeTokens.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1.5">Active links</p>
          <div className="space-y-1.5">
            {activeTokens.map((t: any) => (
              <div key={t.id} className="flex items-center gap-2 text-sm rounded-lg border border-gray-100 bg-neutral-50 px-3 py-2">
                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                <span className="flex-1 text-neutral-700">{DIRECTOR_ACTION_LABELS[t.action as keyof typeof DIRECTOR_ACTION_LABELS] || t.action}</span>
                <span className="text-xs text-neutral-400 inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> expires {fmtDateTime(t.expires_at)}</span>
                {canManage && (
                  <button onClick={() => revoke(t.id)} disabled={busy === 'revoke' + t.id} className="text-neutral-400 hover:text-rose-600" title="Revoke">
                    <Ban className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Audit trail */}
      <div>
        <p className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1.5 flex items-center gap-1.5"><History className="w-3.5 h-3.5" /> Recent access events</p>
        {(data?.events || []).length === 0 ? (
          <p className="text-sm text-neutral-400 italic">No access events yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.events.map((e: any) => (
              <li key={e.id} className="flex items-center gap-2 text-xs text-neutral-500">
                <span className="text-neutral-300 shrink-0 w-32">{fmtDateTime(e.created_at)}</span>
                <span className={`font-medium ${eventTone(e.event_type)}`}>{accessEventLabel(e.event_type)}</span>
                {e.action && <span className="text-neutral-400">· {DIRECTOR_ACTION_LABELS[e.action as keyof typeof DIRECTOR_ACTION_LABELS] || e.action}</span>}
                {e.ip && <span className="text-neutral-300 ml-auto">{e.ip}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function IssueButton({ icon, label, busy, onClick }: { icon: React.ReactNode; label: string; busy: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={busy}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 transition-colors">
      {busy ? <Mail className="w-4 h-4 animate-pulse" /> : icon}{label}
    </button>
  );
}

function eventTone(t: string): string {
  if (['token_completed', 'login', 'attendance_confirmed', 'declaration_signed', 'profile_updated'].includes(t)) return 'text-emerald-600';
  if (['token_expired', 'token_invalid', 'token_revoked', 'denied', 'session_expired'].includes(t)) return 'text-rose-600';
  return 'text-neutral-600';
}
