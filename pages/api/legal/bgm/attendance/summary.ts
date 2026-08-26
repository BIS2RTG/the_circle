import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { summariseAttendance, AttendanceStatus } from '@/lib/bgm';

/**
 * GET /api/legal/bgm/attendance/summary?year=
 * Cumulative attendance per director across recorded meetings (BGM-02).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireBgm(req, res, ['bgm.attendance.view']);
  if (!ctx) return;

  const { data: directors } = await supabaseAdmin
    .from('directors')
    .select('id, full_name, salutation, status')
    .eq('organization_id', ctx.organizationId)
    .order('full_name');

  // Optionally scope to a calendar year via the joined meeting.
  const year = req.query.year ? parseInt(String(req.query.year), 10) : null;

  const { data: rows } = await supabaseAdmin
    .from('meeting_attendance')
    .select('director_id, status, meeting:board_meetings!inner(organization_id, calendar_year)')
    .eq('meeting.organization_id', ctx.organizationId);

  const byDirector = new Map<string, { status: AttendanceStatus | null }[]>();
  for (const r of rows || []) {
    const meeting = (r as any).meeting;
    if (year && meeting?.calendar_year !== year) continue;
    const list = byDirector.get((r as any).director_id) || [];
    list.push({ status: (r as any).status });
    byDirector.set((r as any).director_id, list);
  }

  const summary = (directors || []).map((d) => {
    const s = summariseAttendance(byDirector.get(d.id) || []);
    return { director: d, ...s };
  });

  return res.status(200).json({ summary });
}
