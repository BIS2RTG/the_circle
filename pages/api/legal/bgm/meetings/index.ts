import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { MEETING_TYPES, InviteScope } from '@/lib/bgm';

/**
 * GET  /api/legal/bgm/meetings?year=&type=&committee_id= — list meetings
 * POST /api/legal/bgm/meetings — schedule a meeting (or record a past one) and
 *      open its attendance register.
 *
 * POST body:
 *   title, meeting_type ('board'|'committee'), committee_id?
 *   scheduled_start (ISO), scheduled_end?, time_zone?, location?, is_virtual?, virtual_link?, agenda?
 *   director_ids?: string[]          — custom subset; omit to auto-invite all board / committee members
 *   guests?: [{ full_name, email?, organization?, role?, app_user_id?, azure_oid? }]
 *   invitations_scheduled_for?: ISO  — auto-send invites at this time (cron)
 *   record_only?: boolean            — historical meeting; no invitations
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.meetings.view']);
    if (!ctx) return;

    let query = supabaseAdmin
      .from('board_meetings')
      .select('*, committee:committees(id, name, slug)')
      .eq('organization_id', ctx.organizationId)
      .order('scheduled_start', { ascending: true });

    if (req.query.year) query = query.eq('calendar_year', parseInt(String(req.query.year), 10));
    if (req.query.type) query = query.eq('meeting_type', String(req.query.type));
    if (req.query.committee_id) query = query.eq('committee_id', String(req.query.committee_id));

    const { data: meetings, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const ids = (meetings || []).map((m) => m.id);
    const tally = new Map<string, { invited: number; recorded: number; present: number }>();
    if (ids.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from('meeting_attendance')
        .select('meeting_id, status')
        .in('meeting_id', ids);
      for (const r of rows || []) {
        const t = tally.get(r.meeting_id) || { invited: 0, recorded: 0, present: 0 };
        t.invited += 1;
        if (r.status) t.recorded += 1;
        if (r.status === 'present' || r.status === 'virtual') t.present += 1;
        tally.set(r.meeting_id, t);
      }
    }

    const result = (meetings || []).map((m) => ({
      ...m,
      attendance_tally: tally.get(m.id) || { invited: 0, recorded: 0, present: 0 },
    }));

    return res.status(200).json({ meetings: result });
  }

  if (req.method === 'POST') {
    const ctx = await requireBgm(req, res, ['bgm.meetings.manage']);
    if (!ctx) return;

    const b = req.body || {};
    const type = b.meeting_type;
    if (!MEETING_TYPES.includes(type)) {
      return res.status(400).json({ error: 'meeting_type must be board or committee' });
    }
    if (!b.title || !b.scheduled_start) {
      return res.status(400).json({ error: 'title and scheduled_start are required' });
    }
    if (type === 'committee' && !b.committee_id) {
      return res.status(400).json({ error: 'committee_id is required for committee meetings' });
    }

    const start = new Date(b.scheduled_start);
    if (isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid scheduled_start' });
    const end = b.scheduled_end ? new Date(b.scheduled_end) : new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const isPast = start.getTime() < Date.now();
    const recordOnly = !!b.record_only || isPast;

    // Resolve invited directors.
    const customIds = Array.isArray(b.director_ids) ? b.director_ids.filter((x: any) => typeof x === 'string') : null;
    let inviteeIds: string[] = [];
    let scope: InviteScope;
    if (customIds && customIds.length > 0) {
      // Validate the custom subset belongs to this org.
      const { data: valid } = await supabaseAdmin
        .from('directors')
        .select('id')
        .eq('organization_id', ctx.organizationId)
        .in('id', customIds);
      inviteeIds = (valid || []).map((d) => d.id);
      scope = 'custom';
    } else if (type === 'board') {
      const { data: dirs } = await supabaseAdmin
        .from('directors')
        .select('id')
        .eq('organization_id', ctx.organizationId)
        .eq('status', 'active');
      inviteeIds = (dirs || []).map((d) => d.id);
      scope = 'all_board';
    } else {
      const { data: mem } = await supabaseAdmin
        .from('committee_memberships')
        .select('director_id')
        .eq('committee_id', b.committee_id);
      inviteeIds = (mem || []).map((m) => m.director_id);
      scope = 'committee';
    }

    let scheduledSend: string | null = null;
    if (!recordOnly && b.invitations_scheduled_for) {
      const d = new Date(b.invitations_scheduled_for);
      if (!isNaN(d.getTime()) && d.getTime() > Date.now()) scheduledSend = d.toISOString();
    }

    const { data: meeting, error } = await supabaseAdmin
      .from('board_meetings')
      .insert({
        organization_id: ctx.organizationId,
        title: String(b.title).trim(),
        meeting_type: type,
        committee_id: type === 'committee' ? b.committee_id : null,
        scheduled_start: start.toISOString(),
        scheduled_end: end.toISOString(),
        time_zone: b.time_zone || 'Africa/Harare',
        location: b.location || null,
        is_virtual: !!b.is_virtual,
        virtual_platform: b.is_virtual ? (b.virtual_platform || 'zoom') : null,
        virtual_link: b.virtual_link || null,
        agenda: b.agenda || null,
        calendar_year: start.getUTCFullYear(),
        status: recordOnly ? 'completed' : 'scheduled',
        invite_scope: scope,
        invitations_scheduled_for: scheduledSend,
        created_by: ctx.userId,
      })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Open the attendance register for invited directors.
    if (inviteeIds.length > 0) {
      const rows = inviteeIds.map((did) => ({ meeting_id: meeting.id, director_id: did }));
      const { error: attErr } = await supabaseAdmin
        .from('meeting_attendance')
        .upsert(rows, { onConflict: 'meeting_id,director_id', ignoreDuplicates: true });
      if (attErr) console.error('[bgm] failed to seed attendance register:', attErr);
    }

    // Add non-director guests.
    const guests = Array.isArray(b.guests) ? b.guests : [];
    const guestRows = guests
      .filter((g: any) => g && typeof g.full_name === 'string' && g.full_name.trim())
      .map((g: any) => ({
        meeting_id: meeting.id,
        full_name: g.full_name.trim(),
        email: g.email || null,
        organization: g.organization || null,
        role: g.role || null,
        app_user_id: g.app_user_id || null,
        azure_oid: g.azure_oid || null,
      }));
    if (guestRows.length > 0) {
      const { error: gErr } = await supabaseAdmin.from('meeting_guests').insert(guestRows);
      if (gErr) console.error('[bgm] failed to add guests:', gErr);
    }

    return res.status(201).json({
      id: meeting.id,
      invitees: inviteeIds.length,
      guests: guestRows.length,
      record_only: recordOnly,
      scheduled_send: scheduledSend,
    });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
