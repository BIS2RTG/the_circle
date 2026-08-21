import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';

/**
 * Manage a meeting's invitees after it has been created.
 *   POST   { director_ids?: string[], guests?: [{full_name,email?,organization?,role?,app_user_id?,azure_oid?}] }
 *   DELETE ?director_id=  |  ?guest_id=
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id);
  const ctx = await requireBgm(req, res, ['bgm.meetings.manage']);
  if (!ctx) return;

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings')
    .select('id, finalized_at')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  if (meeting.finalized_at) return res.status(409).json({ error: 'Register is finalized and locked.' });

  if (req.method === 'POST') {
    const b = req.body || {};
    let addedDirectors = 0;
    let addedGuests = 0;

    const directorIds = Array.isArray(b.director_ids) ? b.director_ids.filter((x: any) => typeof x === 'string') : [];
    if (directorIds.length > 0) {
      // Only directors in this org.
      const { data: valid } = await supabaseAdmin
        .from('directors')
        .select('id')
        .eq('organization_id', ctx.organizationId)
        .in('id', directorIds);
      const rows = (valid || []).map((d) => ({ meeting_id: id, director_id: d.id }));
      if (rows.length > 0) {
        const { error, count } = await supabaseAdmin
          .from('meeting_attendance')
          .upsert(rows, { onConflict: 'meeting_id,director_id', ignoreDuplicates: true, count: 'exact' });
        if (error) return res.status(500).json({ error: error.message });
        addedDirectors = count || rows.length;
      }
    }

    const guests = Array.isArray(b.guests) ? b.guests : [];
    const guestRows = guests
      .filter((g: any) => g && typeof g.full_name === 'string' && g.full_name.trim())
      .map((g: any) => ({
        meeting_id: id,
        full_name: g.full_name.trim(),
        email: g.email || null,
        organization: g.organization || null,
        role: g.role || null,
        app_user_id: g.app_user_id || null,
        azure_oid: g.azure_oid || null,
      }));
    if (guestRows.length > 0) {
      const { error } = await supabaseAdmin.from('meeting_guests').insert(guestRows);
      if (error) return res.status(500).json({ error: error.message });
      addedGuests = guestRows.length;
    }

    return res.status(200).json({ ok: true, added_directors: addedDirectors, added_guests: addedGuests });
  }

  if (req.method === 'DELETE') {
    if (req.query.guest_id) {
      const { error } = await supabaseAdmin
        .from('meeting_guests')
        .delete()
        .eq('id', String(req.query.guest_id))
        .eq('meeting_id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
    if (req.query.director_id) {
      const { error } = await supabaseAdmin
        .from('meeting_attendance')
        .delete()
        .eq('meeting_id', id)
        .eq('director_id', String(req.query.director_id));
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'director_id or guest_id required' });
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
