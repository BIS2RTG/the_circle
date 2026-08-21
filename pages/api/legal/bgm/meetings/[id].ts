import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { buildMeetingDetail } from '@/lib/bgmSSR';

/**
 * GET    /api/legal/bgm/meetings/[id] — meeting detail + attendance register.
 * PATCH  /api/legal/bgm/meetings/[id] — edit / reschedule / change status.
 * DELETE /api/legal/bgm/meetings/[id] — cancel (soft: status = cancelled).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.meetings.view']);
    if (!ctx) return;
    // Reuse the SSR loader so the client refetch matches the server-rendered
    // shape exactly (register incl. checkin_link_sent_at, guests, quorum).
    const detail = await buildMeetingDetail(ctx.organizationId, id);
    if (!detail) return res.status(404).json({ error: 'Meeting not found' });
    return res.status(200).json(detail);
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

    const { error } = await supabaseAdmin
      .from('board_meetings')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('organization_id', ctx.organizationId);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
