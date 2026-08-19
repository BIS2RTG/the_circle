import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireDirectorSession } from '@/lib/directorSession';

/**
 * GET /api/portal/me — the signed-in director's dashboard:
 *   profile, upcoming meetings (with their own attendance state), and any
 *   outstanding governance declarations.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireDirectorSession(req, res);
  if (!ctx) return;

  const { director, organizationId, directorId } = ctx;
  const nowIso = new Date().toISOString();

  // Committees this director sits on.
  const { data: memberships } = await supabaseAdmin
    .from('committee_memberships').select('is_chair, committee:committees(id, name)').eq('director_id', directorId);

  // The director's attendance rows joined to their meetings (upcoming + recent).
  const { data: attendance } = await supabaseAdmin
    .from('meeting_attendance')
    .select('status, checked_in_at, meeting:board_meetings(id, title, scheduled_start, scheduled_end, time_zone, is_virtual, location, virtual_link, status, finalized_at, meeting_type)')
    .eq('director_id', directorId);

  const meetings = (attendance || [])
    .filter((a: any) => a.meeting)
    .map((a: any) => ({
      ...a.meeting,
      my_status: a.status,
      confirmed: !!a.status,
    }))
    .filter((m: any) => m.status !== 'cancelled')
    .sort((a: any, b: any) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime());

  const upcoming = meetings.filter((m: any) => new Date(m.scheduled_end || m.scheduled_start).getTime() >= Date.now() - 6 * 3600_000);
  const past = meetings.filter((m: any) => new Date(m.scheduled_end || m.scheduled_start).getTime() < Date.now() - 6 * 3600_000).reverse().slice(0, 10);

  // Outstanding declarations (issued, not yet submitted/cancelled).
  const { data: declarations } = await supabaseAdmin
    .from('governance_declarations')
    .select('id, declaration_type, status, period_year, due_date, submitted_at')
    .eq('director_id', directorId)
    .order('created_at', { ascending: false });

  return res.status(200).json({
    director: { id: director.id, full_name: director.full_name, salutation: director.salutation, email: director.email, phone: (director as any).phone ?? null },
    committees: (memberships || []).map((m: any) => ({ ...m.committee, is_chair: m.is_chair })),
    upcoming,
    past,
    declarations: declarations || [],
    now: nowIso,
  });
}
