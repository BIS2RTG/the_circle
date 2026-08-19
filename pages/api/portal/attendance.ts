import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireDirectorSession } from '@/lib/directorSession';
import { recordAccessEvent } from '@/lib/directorAudit';
import { isSignatureDataUrl } from '@/lib/bgmDeclarationsServer';

/**
 * POST /api/portal/attendance  { meeting_id, signature }
 * The signed-in director confirms their own attendance for a meeting they were
 * invited to. Audited as attendance_confirmed.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireDirectorSession(req, res);
  if (!ctx) return;

  const { meeting_id, signature } = req.body || {};
  if (!meeting_id) return res.status(400).json({ error: 'Missing meeting.' });
  if (!isSignatureDataUrl(signature)) return res.status(400).json({ error: 'Please sign to confirm your attendance.' });

  const { data: meeting } = await supabaseAdmin
    .from('board_meetings').select('id, finalized_at, status').eq('id', meeting_id).eq('organization_id', ctx.organizationId).maybeSingle();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
  if (meeting.finalized_at) return res.status(409).json({ error: 'This attendance register is finalized.' });

  const { data: att } = await supabaseAdmin
    .from('meeting_attendance').select('id, status').eq('meeting_id', meeting_id).eq('director_id', ctx.directorId).maybeSingle();
  if (!att) return res.status(403).json({ error: 'You are not on the invitee list for this meeting.' });
  if (att.status) return res.status(409).json({ error: 'Your attendance is already recorded.' });

  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin.from('meeting_attendance')
    .update({ status: 'present', checked_in_at: nowIso, check_in_method: 'self_token', check_in_signature: signature, recorded_at: nowIso, confirmed_by_director: true })
    .eq('id', att.id);
  if (error) return res.status(500).json({ error: 'Could not record your attendance.' });

  await recordAccessEvent({
    organizationId: ctx.organizationId, eventType: 'attendance_confirmed',
    directorId: ctx.directorId, sessionId: ctx.sessionId, action: 'confirm_attendance',
    detail: 'portal', req, metadata: { meeting_id },
  });
  return res.status(200).json({ ok: true });
}
