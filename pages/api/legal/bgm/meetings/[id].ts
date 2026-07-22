import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { cancelOutlookMeeting } from '@/lib/graphCalendar';
import { getValidMsAccessToken } from '@/lib/msTokenStore';
import { defaultQuorum } from '@/lib/bgm';

/**
 * GET   /api/legal/bgm/meetings/[id] — meeting detail + attendance register.
 * PATCH /api/legal/bgm/meetings/[id] — edit / reschedule / change status.
 * DELETE /api/legal/bgm/meetings/[id] — cancel (soft: status=cancelled + cancel Outlook event).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.meetings.view']);
    if (!ctx) return;

    const { data: meeting, error } = await supabaseAdmin
      .from('board_meetings')
      .select('*, committee:committees(id, name, slug)')
      .eq('id', id)
      .eq('organization_id', ctx.organizationId)
      .single();

    if (error || !meeting) return res.status(404).json({ error: 'Meeting not found' });

    const { data: register } = await supabaseAdmin
      .from('meeting_attendance')
      .select('id, director_id, status, rsvp_status, rsvp_note, note, checked_in_at, check_in_method, check_in_signature, confirmed_by_director, recorded_at, director:directors(id, full_name, salutation, email, status)')
      .eq('meeting_id', id);

    const rows = (register || [])
      .map((r: any) => ({
        id: r.id,
        director_id: r.director_id,
        status: r.status,
        rsvp_status: r.rsvp_status,
        rsvp_note: r.rsvp_note,
        note: r.note,
        checked_in_at: r.checked_in_at,
        check_in_method: r.check_in_method,
        check_in_signature: r.check_in_signature,
        confirmed_by_director: r.confirmed_by_director,
        recorded_at: r.recorded_at,
        full_name: r.director?.full_name,
        salutation: r.director?.salutation,
        email: r.director?.email,
      }))
      .sort((a: any, b: any) => (a.full_name || '').localeCompare(b.full_name || ''));

    const { data: guests } = await supabaseAdmin
      .from('meeting_guests')
      .select('id, full_name, email, organization, role, app_user_id, rsvp_status, status, note, checked_in_at, check_in_signature')
      .eq('meeting_id', id)
      .order('full_name');

    const quorum = meeting.quorum ?? defaultQuorum(rows.length);

    return res.status(200).json({ meeting, register: rows, guests: guests || [], quorum });
  }

  if (req.method === 'PATCH') {
    const ctx = await requireBgm(req, res, ['bgm.meetings.manage']);
    if (!ctx) return;

    const b = req.body || {};
    const patch: Record<string, any> = {};
    for (const f of ['title', 'location', 'virtual_link', 'virtual_platform', 'agenda', 'time_zone', 'status']) {
      if (f in b) patch[f] = b[f] === '' ? null : b[f];
    }
    if ('is_virtual' in b) patch.is_virtual = !!b.is_virtual;
    if ('quorum' in b) patch.quorum = b.quorum === null || b.quorum === '' ? null : parseInt(String(b.quorum), 10);
    if ('invitations_scheduled_for' in b) {
      patch.invitations_scheduled_for = b.invitations_scheduled_for ? new Date(b.invitations_scheduled_for).toISOString() : null;
    }
    if ('scheduled_start' in b && b.scheduled_start) {
      const d = new Date(b.scheduled_start);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid scheduled_start' });
      patch.scheduled_start = d.toISOString();
      patch.calendar_year = d.getUTCFullYear();
    }
    if ('scheduled_end' in b && b.scheduled_end) {
      const d = new Date(b.scheduled_end);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid scheduled_end' });
      patch.scheduled_end = d.toISOString();
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const { error } = await supabaseAdmin
      .from('board_meetings')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', ctx.organizationId);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const ctx = await requireBgm(req, res, ['bgm.meetings.manage']);
    if (!ctx) return;

    const { data: meeting } = await supabaseAdmin
      .from('board_meetings')
      .select('outlook_event_id')
      .eq('id', id)
      .eq('organization_id', ctx.organizationId)
      .single();

    const { error } = await supabaseAdmin
      .from('board_meetings')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('organization_id', ctx.organizationId);

    if (error) return res.status(500).json({ error: error.message });

    // Best-effort: withdraw the Outlook invitation if one was sent.
    if (meeting?.outlook_event_id) {
      try {
        const token = await getValidMsAccessToken(ctx.userId);
        if (token) await cancelOutlookMeeting(token, meeting.outlook_event_id, 'This board meeting has been cancelled.');
      } catch (err) {
        console.error('[bgm] failed to cancel Outlook event:', err);
      }
    }

    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
