import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getDeclarationDef } from '@/lib/bgmDeclarations';
import { applyDeclarationSubmission, isSignatureDataUrl } from '@/lib/bgmDeclarationsServer';

/**
 * PUBLIC (token-gated, no login) governance declaration completion — the
 * director opens their personal link, fills the digital form, and e-signs.
 *   GET  /api/legal/bgm/declaration/[token]  → { def_type, director, declaration, already }
 *   POST /api/legal/bgm/declaration/[token]  { form_data, signature, signed_name, declaration_confirmed }
 * The token is single-use: it is cleared on submission.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const { data: decl } = await supabaseAdmin
    .from('governance_declarations')
    .select('id, declaration_type, status, period_year, due_date, form_data, token_expires_at, director:directors(full_name, salutation)')
    .eq('access_token', token).maybeSingle();

  if (!decl) return res.status(404).json({ error: 'This declaration link is not valid or has already been completed.' });

  if (decl.status === 'cancelled') return res.status(410).json({ error: 'This declaration has been withdrawn.' });
  if (decl.token_expires_at && new Date(decl.token_expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'This declaration link has expired. Please ask the Company Secretary to re-issue it.' });
  }

  const def = getDeclarationDef(decl.declaration_type);
  if (!def) return res.status(400).json({ error: 'Unknown declaration type.' });
  const director = (decl as any).director;

  if (req.method === 'GET') {
    return res.status(200).json({
      type: decl.declaration_type,
      director: { full_name: director?.full_name || 'Director', salutation: director?.salutation || null },
      declaration: { period_year: decl.period_year, due_date: decl.due_date, form_data: decl.form_data || {} },
      already: decl.status === 'submitted',
    });
  }

  if (req.method === 'POST') {
    if (decl.status === 'submitted') return res.status(409).json({ error: 'This declaration has already been submitted.' });

    const { form_data, signature, signed_name, declaration_confirmed } = req.body || {};
    if (!declaration_confirmed) return res.status(400).json({ error: 'Please tick the declaration to confirm.' });
    if (!isSignatureDataUrl(signature)) return res.status(400).json({ error: 'Please sign in the box to complete your declaration.' });

    // Re-fetch the full row for the shared side-effect helper.
    const { data: full } = await supabaseAdmin
      .from('governance_declarations').select('*').eq('id', decl.id).maybeSingle();
    if (!full) return res.status(404).json({ error: 'Declaration not found.' });

    const result = await applyDeclarationSubmission({
      declaration: full,
      formData: form_data && typeof form_data === 'object' ? form_data : {},
      signature,
      signedName: typeof signed_name === 'string' && signed_name.trim() ? signed_name.trim() : (director?.full_name || null),
      declarationConfirmed: true,
      via: 'self_link',
    });
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
