import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { summariseAttendance, AttendanceStatus } from '@/lib/bgm';

/**
 * GET   /api/legal/bgm/directors/[id] — director profile, committees and
 *                                       cumulative attendance history (BGM-02).
 * PATCH /api/legal/bgm/directors/[id] — update director fields.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.directors.view', 'bgm.attendance.view']);
    if (!ctx) return;

    const { data: director, error } = await supabaseAdmin
      .from('directors')
      .select('*')
      .eq('id', id)
      .eq('organization_id', ctx.organizationId)
      .single();

    if (error || !director) return res.status(404).json({ error: 'Director not found' });

    const { data: memberships } = await supabaseAdmin
      .from('committee_memberships')
      .select('is_chair, committee:committees(id, name, slug)')
      .eq('director_id', id);

    // Attendance history: join register rows to their meetings.
    const { data: attendance } = await supabaseAdmin
      .from('meeting_attendance')
      .select('status, note, meeting:board_meetings(id, title, meeting_type, scheduled_start, status)')
      .eq('director_id', id);

    const history = (attendance || [])
      .filter((a: any) => a.meeting)
      .sort((a: any, b: any) =>
        new Date(b.meeting.scheduled_start).getTime() - new Date(a.meeting.scheduled_start).getTime()
      )
      .map((a: any) => ({
        status: a.status as AttendanceStatus | null,
        note: a.note,
        meeting_id: a.meeting.id,
        meeting_title: a.meeting.title,
        meeting_type: a.meeting.meeting_type,
        scheduled_start: a.meeting.scheduled_start,
        meeting_status: a.meeting.status,
      }));

    const summary = summariseAttendance(history);

    return res.status(200).json({
      director,
      committees: (memberships || []).map((m: any) => ({ ...m.committee, is_chair: m.is_chair })),
      history,
      summary,
    });
  }

  if (req.method === 'PATCH') {
    const ctx = await requireBgm(req, res, ['bgm.directors.manage']);
    if (!ctx) return;

    const b = req.body || {};
    const patch: Record<string, any> = {};
    for (const f of ['full_name', 'salutation', 'email', 'phone', 'appointed_date', 'term_end_date', 'notes', 'status']) {
      if (f in b) patch[f] = b[f] === '' ? null : b[f];
    }
    if ('is_independent' in b) patch.is_independent = typeof b.is_independent === 'boolean' ? b.is_independent : null;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const { error } = await supabaseAdmin
      .from('directors')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', ctx.organizationId);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
