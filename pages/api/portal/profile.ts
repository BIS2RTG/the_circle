import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireDirectorSession } from '@/lib/directorSession';
import { recordAccessEvent } from '@/lib/directorAudit';

/**
 * POST /api/portal/profile  { salutation?, email?, phone? }
 * The signed-in director updates their own contact details. Audited.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireDirectorSession(req, res);
  if (!ctx) return;

  const b = req.body || {};
  const patch: Record<string, any> = {};
  if (typeof b.salutation === 'string') patch.salutation = b.salutation.trim() || null;
  if (typeof b.email === 'string') {
    const email = b.email.trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email address.' });
    patch.email = email;
  }
  if (typeof b.phone === 'string') patch.phone = b.phone.trim() || null;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const { error } = await supabaseAdmin.from('directors').update(patch).eq('id', ctx.directorId);
  if (error) return res.status(500).json({ error: 'Could not update your profile.' });

  await recordAccessEvent({
    organizationId: ctx.organizationId, eventType: 'profile_updated',
    directorId: ctx.directorId, sessionId: ctx.sessionId, action: 'update_profile',
    detail: Object.keys(patch).join(','), req,
  });
  return res.status(200).json({ ok: true });
}
