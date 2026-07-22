import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { ATTENDANCE_STATUSES, RSVP_STATUSES, AttendanceStatus, RsvpStatus } from '@/lib/bgm';

/**
 * PUT /api/legal/bgm/attendance/[meetingId]
 * Record RSVP and/or attendance for a meeting (BGM-02). Body:
 *   { entries: [{ kind: 'director'|'guest', id, status?, rsvp_status?, note?, checked_in? }] }
 * - kind 'director' → id is director_id; kind 'guest' → id is meeting_guests.id
 * - status null clears attendance; checked_in true stamps a secretary check-in.
 *
 * Check-in provenance is PRESERVED: if the attendee already has a check-in
 * (e.g. they self-checked-in via QR), later secretary edits (RSVP, notes, a
 * re-save of the same present status) never overwrite when/how they checked in.
 * A fresh secretary stamp is only applied when there is no existing check-in.
 * Blocked once the meeting register is finalized.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const meetingId = String(req.query.meetingId);
  const ctx = await requireBgm(req, res, ['bgm.attendance.manage']);
  if (!ctx) return;

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, finalized_at')
    .eq('id', meetingId)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  if (meeting.finalized_at) {
    return res.status(409).json({ error: 'This register has been finalized and is locked. Re-open it to make changes.' });
  }

  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) return res.status(400).json({ error: 'entries array is required' });

  // Existing check-in state, so we never clobber a self-check-in.
  const { data: existingDirs } = await supabaseAdmin
    .from('meeting_attendance')
    .select('director_id, checked_in_at, check_in_method')
    .eq('meeting_id', meetingId);
  const dirCheckin = new Map<string, { at: string | null; method: string | null }>();
  for (const r of existingDirs || []) dirCheckin.set(r.director_id, { at: r.checked_in_at, method: r.check_in_method });

  const { data: existingGuests } = await supabaseAdmin
    .from('meeting_guests')
    .select('id, checked_in_at')
    .eq('meeting_id', meetingId);
  const guestCheckin = new Map<string, { at: string | null }>();
  for (const g of existingGuests || []) guestCheckin.set(g.id, { at: g.checked_in_at });

  const now = new Date().toISOString();
  let updated = 0;
  const errors: string[] = [];

  for (const e of entries) {
    if (!e || typeof e.id !== 'string') continue;

    const hasStatus = 'status' in e;
    const status: AttendanceStatus | null = e.status ?? null;
    if (hasStatus && status !== null && !ATTENDANCE_STATUSES.includes(status)) {
      errors.push(`Invalid status "${status}"`); continue;
    }
    const hasRsvp = 'rsvp_status' in e;
    const rsvp: RsvpStatus | undefined = e.rsvp_status;
    if (hasRsvp && rsvp && !RSVP_STATUSES.includes(rsvp)) {
      errors.push(`Invalid rsvp_status "${rsvp}"`); continue;
    }

    const isGuest = e.kind === 'guest';
    const existing = isGuest ? guestCheckin.get(e.id) : dirCheckin.get(e.id);
    const attended = status === 'present' || status === 'virtual';
    const explicitCheckIn = 'checked_in' in e && e.checked_in === true;

    const patch: Record<string, any> = {};
    if (hasStatus) {
      patch.status = status;
      if (!isGuest) {
        patch.recorded_by = ctx.userId;
        patch.recorded_at = status ? now : null;
      }
      if (attended) {
        // Preserve an existing check-in (e.g. self_qr); only stamp fresh.
        if (!existing?.at) {
          patch.checked_in_at = now;
          if (!isGuest) patch.check_in_method = 'secretary';
        }
      } else {
        // Not present → no check-in on record.
        patch.checked_in_at = null;
        if (!isGuest) patch.check_in_method = null;
      }
    }
    if (explicitCheckIn && !existing?.at) {
      patch.checked_in_at = now;
      if (!isGuest) patch.check_in_method = 'secretary';
    }
    if (hasRsvp) {
      patch.rsvp_status = rsvp || 'no_response';
      patch.rsvp_at = rsvp && rsvp !== 'no_response' ? now : null;
    }
    if ('note' in e) {
      patch.note = typeof e.note === 'string' ? e.note : null;
    }
    if (Object.keys(patch).length === 0) continue;

    if (isGuest) {
      const { error, count } = await supabaseAdmin
        .from('meeting_guests')
        .update(patch, { count: 'exact' })
        .eq('id', e.id)
        .eq('meeting_id', meetingId);
      if (error) errors.push(error.message); else updated += count || 0;
    } else {
      const { error, count } = await supabaseAdmin
        .from('meeting_attendance')
        .update(patch, { count: 'exact' })
        .eq('meeting_id', meetingId)
        .eq('director_id', e.id);
      if (error) errors.push(error.message); else updated += count || 0;
    }
  }

  if (errors.length > 0) return res.status(207).json({ updated, errors });
  return res.status(200).json({ ok: true, updated });
}
