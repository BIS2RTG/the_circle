import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { issueDirectorLink } from '@/lib/directorTokens';

/**
 * POST /api/portal/login-request  { email }
 * Director self-service portal sign-in: if the email matches an active director,
 * email them a single-use portal_login link. Always responds generically so the
 * endpoint cannot be used to enumerate which emails belong to directors.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const generic = { ok: true, message: 'If that email is on file, a secure sign-in link is on its way.' };
  if (!email || !email.includes('@')) return res.status(200).json(generic);

  // Match an active director by email (case-insensitive).
  const { data: director } = await supabaseAdmin
    .from('directors')
    .select('id, organization_id, full_name, salutation, email, status')
    .ilike('email', email)
    .eq('status', 'active')
    .maybeSingle();

  if (director) {
    await issueDirectorLink({
      organizationId: director.organization_id,
      director,
      action: 'portal_login',
      req,
    });
  }

  return res.status(200).json(generic);
}
